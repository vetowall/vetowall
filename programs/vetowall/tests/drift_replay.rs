//! Replays the April 2026 Drift admin takeover against `mock_vault`, once with
//! a hot admin key and once with Vetowall as the admin, and checks the limits
//! on Vetowall's guardian.

use {
    vetowall::{error::ErrorCode as VetowallError, ActionClass, Config, Proposal, ProposalStatus, StoredMeta},
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::{types::FailedTransactionMetadata, LiteSVM},
    litesvm_token::{
        get_spl_account, spl_token::state::Account as TokenAccount, CreateAssociatedTokenAccount,
        CreateMint, MintTo,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_nonce::state::DurableNonce,
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const HOUR: i64 = 3600;
const DAY: i64 = 24 * HOUR;
/// Safe, Params, Authority, Max: the delays the plan calls for on mainnet.
const DELAYS: [i64; 4] = [0, 48 * HOUR, 72 * HOUR, 7 * DAY];
const USDC: u64 = 1_000_000;
const RESERVE: u64 = 1_000_000 * USDC;
const LIMIT: u64 = 10_000 * USDC;

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    /// Stands in for the Squads vault PDA.
    proposer: Keypair,
    guardian: Keypair,
    config: Pubkey,
    authority: Pubkey,
    usdc: Pubkey,
    vault: Pubkey,
    reserve: Pubkey,
    attacker: Keypair,
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), FailedTransactionMetadata> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    let res = svm.send_transaction(tx).map(|_| ());
    // Each test step lands in its own block so identical txs don't collide.
    svm.expire_blockhash();
    res
}

/// Builds every instruction before borrowing the SVM mutably.
macro_rules! tx {
    ($env:expr, [$($ix:expr),* $(,)?], [$($signer:expr),* $(,)?]) => {{
        let ixs = vec![$($ix),*];
        send(&mut $env.svm, &ixs, &[$($signer),*])
    }};
}

fn assert_err<T: std::fmt::Debug>(res: Result<T, FailedTransactionMetadata>, code: u32) {
    let err = res.expect_err("transaction should have failed").err;
    let got = format!("{err:?}");
    assert!(got.contains(&format!("Custom({code})")), "expected custom error {code}, got {got}");
}

fn code(e: VetowallError) -> u32 {
    u32::from(e)
}

fn warp(svm: &mut LiteSVM, seconds: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp += seconds;
    clock.slot += (seconds as u64) * 2;
    svm.set_sysvar(&clock);
}

fn vault_pda(creator: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[mock_vault::VAULT_SEED, creator.as_ref()], &mock_vault::id()).0
}

fn reserve_pda(vault: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[mock_vault::RESERVE_SEED, vault.as_ref()], &mock_vault::id()).0
}

fn token_balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    get_spl_account::<TokenAccount>(svm, account).unwrap().amount
}

fn load<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let account = svm.get_account(key).unwrap();
    T::try_deserialize(&mut &account.data[..]).unwrap()
}

/// A mock_vault admin instruction, signed by `admin`.
fn admin_ix(vault: Pubkey, admin: Pubkey, data: Vec<u8>) -> Instruction {
    Instruction::new_with_bytes(
        mock_vault::id(),
        &data,
        mock_vault::accounts::Admin { vault, admin }.to_account_metas(None),
    )
}

fn stored(ix: &Instruction) -> Vec<StoredMeta> {
    ix.accounts
        .iter()
        .map(|m| StoredMeta {
            pubkey: m.pubkey,
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect()
}

/// mock_vault is an Anchor program: 8-byte discriminators, no wide tags.
const DISC_LEN: u8 = 8;

fn policy_pda(config: &Pubkey, ix: &Instruction) -> Pubkey {
    vetowall::firewall::policy_address(config, &ix.program_id, &vetowall::firewall::discriminator(&ix.data, DISC_LEN, &[]))
}

fn target_pda(config: &Pubkey, ix: &Instruction) -> Pubkey {
    vetowall::firewall::target_address(config, &ix.program_id)
}

fn create_vault(env: &mut Env, creator: &Keypair) -> (Pubkey, Pubkey) {
    let vault = vault_pda(&creator.pubkey());
    let reserve = reserve_pda(&vault);
    let ix = Instruction::new_with_bytes(
        mock_vault::id(),
        &mock_vault::instruction::Initialize { withdraw_limit: LIMIT }.data(),
        mock_vault::accounts::Initialize {
            creator: creator.pubkey(),
            vault,
            usdc_mint: env.usdc,
            reserve,
            token_program: litesvm_token::TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    tx!(env, [ix], [creator]).unwrap();
    MintTo::new(&mut env.svm, &env.payer, &env.usdc, &reserve, RESERVE).send().unwrap();
    (vault, reserve)
}

/// A guarded vault: admin is Vetowall's authority PDA, with policies
/// registered and the config sealed.
fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(vetowall::id(), include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/vetowall.so")))
        .unwrap();
    svm.add_program(mock_vault::id(), include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/mock_vault.so")))
        .unwrap();
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = 1_775_000_000; // Apr 2026
    svm.set_sysvar(&clock);

    let payer = Keypair::new();
    let proposer = Keypair::new();
    let guardian = Keypair::new();
    let attacker = Keypair::new();
    for k in [&payer, &proposer, &guardian, &attacker] {
        svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    }
    let usdc = CreateMint::new(&mut svm, &payer).decimals(6).send().unwrap();

    let config_kp = Keypair::new();
    let config = config_kp.pubkey();
    let authority =
        Pubkey::find_program_address(&[vetowall::AUTHORITY_SEED, config.as_ref()], &vetowall::id()).0;
    // The authority PDA pays rent when governance registers policies.
    svm.airdrop(&authority, 1_000_000_000).unwrap();

    let mut env = Env {
        svm,
        payer,
        proposer,
        guardian,
        config,
        authority,
        usdc,
        vault: Pubkey::default(),
        reserve: Pubkey::default(),
        attacker,
    };

    let init = Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Initialize {
            proposer: env.proposer.pubkey(),
            approver: None,
            guardian: env.guardian.pubkey(),
            delays: DELAYS,
        }
        .data(),
        vetowall::accounts::Initialize {
            admin: env.payer.pubkey(),
            config,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    tx!(env, [init], [&env.payer, &config_kp]).unwrap();

    let creator = Keypair::new();
    env.svm.airdrop(&creator.pubkey(), 10_000_000_000).unwrap();
    let (vault, reserve) = create_vault(&mut env, &creator);
    env.vault = vault;
    env.reserve = reserve;

    let policies = [
        (mock_vault::instruction::ListCollateral { mint: Pubkey::default(), price: 0, weight_bps: 0 }.data(), ActionClass::Params),
        (mock_vault::instruction::SetWithdrawLimit { withdraw_limit: 0 }.data(), ActionClass::Params),
        (mock_vault::instruction::SetAdmin { new_admin: Pubkey::default() }.data(), ActionClass::Authority),
        (mock_vault::instruction::Pause {}.data(), ActionClass::Safe),
    ];
    for (data, class) in policies {
        let disc = vetowall::firewall::discriminator(&data, DISC_LEN, &[]);
        let ix = register_ix(&env, env.payer.pubkey(), disc, class);
        tx!(env, [ix], [&env.payer]).unwrap();
    }
    let seal = Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Seal {}.data(),
        vetowall::accounts::Seal { config, admin: env.payer.pubkey() }.to_account_metas(None),
    );
    tx!(env, [seal], [&env.payer]).unwrap();

    // Hand the vault to Vetowall.
    let handover = admin_ix(vault, creator.pubkey(), mock_vault::instruction::SetAdmin { new_admin: authority }.data());
    tx!(env, [handover], [&creator]).unwrap();
    env
}

fn register_ix(env: &Env, governor: Pubkey, disc: [u8; 8], class: ActionClass) -> Instruction {
    let policy = vetowall::firewall::policy_address(&env.config, &mock_vault::id(), &disc);
    Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Register { target_program: mock_vault::id(), discriminator: disc, disc_len: DISC_LEN, class, limit: None }.data(),
        vetowall::accounts::Register {
            config: env.config,
            governor,
            target: vetowall::firewall::target_address(&env.config, &mock_vault::id()),
            policy,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn queue_ix(env: &Env, target: &Instruction) -> Instruction {
    let cfg: Config = load(&env.svm, &env.config);
    let proposal = proposal_pda(env, cfg.proposal_count);
    Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Queue {
            target_program: target.program_id,
            accounts: stored(target),
            data: target.data.clone(),
        }
        .data(),
        vetowall::accounts::Queue {
            config: env.config,
            proposer: env.proposer.pubkey(),
            approver: None,
            proposal,
            target: target_pda(&env.config, target),
            policy: policy_pda(&env.config, target),
            instructions: solana_instructions_sysvar_id(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn proposal_pda(env: &Env, id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[vetowall::PROPOSAL_SEED, env.config.as_ref(), &id.to_le_bytes()],
        &vetowall::id(),
    )
    .0
}

fn solana_instructions_sysvar_id() -> Pubkey {
    solana_instructions_sysvar::ID
}

/// Remaining accounts for a stored instruction: its accounts, never as
/// signers (the PDA signs inside), then the target program.
fn remaining(target: &Instruction) -> Vec<AccountMeta> {
    let mut metas: Vec<AccountMeta> = target
        .accounts
        .iter()
        .map(|m| AccountMeta { pubkey: m.pubkey, is_signer: false, is_writable: m.is_writable })
        .collect();
    metas.push(AccountMeta::new_readonly(target.program_id, false));
    metas
}

fn execute_ix(env: &Env, id: u64, target: &Instruction) -> Instruction {
    let mut metas = vetowall::accounts::Execute {
        config: env.config,
        proposal: proposal_pda(env, id),
        target: target_pda(&env.config, target),
        policy: policy_pda(&env.config, target),
        reserve: None,
        instructions: solana_instructions_sysvar_id(),
    }
    .to_account_metas(None);
    metas.extend(remaining(target));
    Instruction::new_with_bytes(vetowall::id(), &vetowall::instruction::Execute {}.data(), metas)
}

fn veto_ix(env: &Env, id: u64, signer: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Veto { reason: [7; 32] }.data(),
        vetowall::accounts::Veto { config: env.config, guardian: signer, proposal: proposal_pda(env, id) }
            .to_account_metas(None),
    )
}

fn guardian_execute_ix(env: &Env, target: &Instruction) -> Instruction {
    let mut metas = vetowall::accounts::GuardianExecute {
        config: env.config,
        guardian: env.guardian.pubkey(),
        target: target_pda(&env.config, target),
        policy: policy_pda(&env.config, target),
        instructions: solana_instructions_sysvar_id(),
    }
    .to_account_metas(None);
    metas.extend(remaining(target));
    Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::GuardianExecute {
            target_program: target.program_id,
            accounts: stored(target),
            data: target.data.clone(),
        }
        .data(),
        metas,
    )
}

/// The attacker's side of Drift: a worthless token, listed at a fake price.
fn fake_collateral(env: &mut Env) -> (Pubkey, Pubkey) {
    let mint = CreateMint::new(&mut env.svm, &env.attacker).decimals(6).send().unwrap();
    let ata = CreateAssociatedTokenAccount::new(&mut env.svm, &env.attacker, &mint)
        .owner(&env.attacker.pubkey())
        .send()
        .unwrap();
    MintTo::new(&mut env.svm, &env.attacker, &mint, &ata, 1_000_000 * USDC).send().unwrap();
    (mint, ata)
}

/// Deposits the fake collateral and borrows the reserve dry, one
/// limit-sized withdrawal at a time. Returns how much left the vault.
fn drain(env: &mut Env, vault: Pubkey, reserve: Pubkey, mint: Pubkey, ata: Pubkey) -> u64 {
    let collateral = Pubkey::find_program_address(
        &[mock_vault::COLLATERAL_SEED, vault.as_ref(), mint.as_ref()],
        &mock_vault::id(),
    )
    .0;
    let position = Pubkey::find_program_address(
        &[mock_vault::POSITION_SEED, vault.as_ref(), env.attacker.pubkey().as_ref()],
        &mock_vault::id(),
    )
    .0;
    let deposit = Instruction::new_with_bytes(
        mock_vault::id(),
        &mock_vault::instruction::DepositCollateral { amount: 1_000_000 * USDC }.data(),
        mock_vault::accounts::DepositCollateral {
            owner: env.attacker.pubkey(),
            vault,
            mint,
            owner_tokens: ata,
            collateral,
            position,
            token_program: litesvm_token::TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    if tx!(env, [deposit], [&env.attacker]).is_err() {
        return 0;
    }
    let usdc = env.usdc;
    let dest = CreateAssociatedTokenAccount::new(&mut env.svm, &env.attacker, &usdc)
        .owner(&env.attacker.pubkey())
        .send()
        .unwrap();
    let before = token_balance(&env.svm, &reserve);
    loop {
        let left = token_balance(&env.svm, &reserve);
        let limit = load::<mock_vault::Vault>(&env.svm, &vault).withdraw_limit;
        let amount = left.min(limit);
        if amount == 0 {
            break;
        }
        let borrow = Instruction::new_with_bytes(
            mock_vault::id(),
            &mock_vault::instruction::Borrow { amount }.data(),
            mock_vault::accounts::Borrow {
                owner: env.attacker.pubkey(),
                vault,
                reserve,
                destination: dest,
                position,
                token_program: litesvm_token::TOKEN_ID,
            }
            .to_account_metas(None),
        );
        if tx!(env, [borrow], [&env.attacker]).is_err() {
            break;
        }
    }
    before - token_balance(&env.svm, &reserve)
}

/// A nonce account owned by `authority`, and the durable nonce a transaction
/// must use as its blockhash.
fn nonce_account(svm: &mut LiteSVM, payer: &Keypair, authority: &Pubkey) -> (Pubkey, solana_hash::Hash) {
    let nonce = Keypair::new();
    let ixs = solana_system_interface::instruction::create_nonce_account(
        &payer.pubkey(),
        &nonce.pubkey(),
        authority,
        10_000_000,
    );
    let blockhash = svm.latest_blockhash();
    send(svm, &ixs, &[payer, &nonce]).unwrap();
    (nonce.pubkey(), *DurableNonce::from_blockhash(&blockhash).as_hash())
}

/// Signs `ixs` against a durable nonce, then lets "days" of blocks pass
/// before it's submitted. That is the Drift pre-signing pattern.
fn send_presigned(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair], nonce: Pubkey, nonce_authority: &Pubkey, durable: solana_hash::Hash) -> Result<(), FailedTransactionMetadata> {
    let mut all = vec![solana_system_interface::instruction::advance_nonce_account(&nonce, nonce_authority)];
    all.extend_from_slice(ixs);
    let msg = Message::new_with_blockhash(&all, Some(&signers[0].pubkey()), &durable);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    for _ in 0..300 {
        svm.expire_blockhash(); // well past the ~150-block recent-blockhash window
    }
    svm.send_transaction(tx).map(|_| ())
}

#[test]
fn control_unguarded_vault_is_drained_by_presigned_admin_tx() {
    let mut env = setup();
    let hot_admin = Keypair::new();
    env.svm.airdrop(&hot_admin.pubkey(), 10_000_000_000).unwrap();
    let (vault, reserve) = create_vault(&mut env, &hot_admin);
    let (mint, ata) = fake_collateral(&mut env);

    // The admin signs the "routine" change days ahead, against a durable nonce.
    let (nonce, durable) = nonce_account(&mut env.svm, &hot_admin, &hot_admin.pubkey());
    let list = admin_ix(vault, hot_admin.pubkey(), mock_vault::instruction::ListCollateral { mint, price: 1_000 * USDC, weight_bps: 10_000 }.data());
    let raise = admin_ix(vault, hot_admin.pubkey(), mock_vault::instruction::SetWithdrawLimit { withdraw_limit: 20 * LIMIT }.data());
    send_presigned(&mut env.svm, &[list, raise], &[&hot_admin], nonce, &hot_admin.pubkey(), durable).unwrap();

    let taken = drain(&mut env, vault, reserve, mint, ata);
    assert_eq!(taken, RESERVE, "unguarded vault should be emptied");
    assert_eq!(token_balance(&env.svm, &reserve), 0);
}

#[test]
fn presigned_durable_nonce_queue_is_refused() {
    let mut env = setup();
    let attacker = env.attacker.pubkey();
    let (nonce, durable) = nonce_account(&mut env.svm, &env.payer, &env.proposer.pubkey());
    let takeover = admin_ix(env.vault, env.authority, mock_vault::instruction::SetAdmin { new_admin: attacker }.data());
    let queue = queue_ix(&env, &takeover);
    let proposer = env.proposer.insecure_clone();
    let res = send_presigned(&mut env.svm, &[queue], &[&proposer], nonce, &proposer.pubkey(), durable);
    assert_err(res, code(VetowallError::NonceTxForbidden));
}

#[test]
fn presigned_durable_nonce_execute_is_refused() {
    let mut env = setup();
    let (mint, _) = fake_collateral(&mut env);
    let list = admin_ix(env.vault, env.authority, mock_vault::instruction::ListCollateral { mint, price: USDC, weight_bps: 5_000 }.data());
    tx!(env, [queue_ix(&env, &list)], [&env.proposer]).unwrap();
    warp(&mut env.svm, 48 * HOUR);

    let executor = Keypair::new();
    env.svm.airdrop(&executor.pubkey(), 1_000_000_000).unwrap();
    let (nonce, durable) = nonce_account(&mut env.svm, &executor, &executor.pubkey());
    let execute = execute_ix(&env, 0, &list);
    let res = send_presigned(&mut env.svm, &[execute], &[&executor], nonce, &executor.pubkey(), durable);
    assert_err(res, code(VetowallError::NonceTxForbidden));
}

#[test]
fn each_class_waits_out_its_own_timelock() {
    let mut env = setup();
    let (mint, _) = fake_collateral(&mut env);
    let list = admin_ix(env.vault, env.authority, mock_vault::instruction::ListCollateral { mint, price: USDC, weight_bps: 5_000 }.data());
    let unpause = admin_ix(env.vault, env.authority, mock_vault::instruction::Unpause {}.data());
    tx!(env, [queue_ix(&env, &list)], [&env.proposer]).unwrap();
    tx!(env, [queue_ix(&env, &unpause)], [&env.proposer]).unwrap();

    let p0: Proposal = load(&env.svm, &proposal_pda(&env, 0));
    let p1: Proposal = load(&env.svm, &proposal_pda(&env, 1));
    assert_eq!(p0.class, ActionClass::Params);
    assert_eq!(p0.eta - p0.queued_at, 48 * HOUR);
    assert_eq!(p1.class, ActionClass::Max, "unregistered instructions default to Max");
    assert_eq!(p1.eta - p1.queued_at, 7 * DAY);

    assert_err(tx!(env, [execute_ix(&env, 0, &list)], [&env.payer]), code(VetowallError::TooEarly));
    warp(&mut env.svm, 48 * HOUR);
    tx!(env, [execute_ix(&env, 0, &list)], [&env.payer]).unwrap();
    let vault: mock_vault::Vault = load(&env.svm, &env.vault);
    assert!(vault.market(&mint).is_some());
    assert_err(tx!(env, [execute_ix(&env, 0, &list)], [&env.payer]), code(VetowallError::NotQueued));
    assert_err(tx!(env, [execute_ix(&env, 1, &unpause)], [&env.payer]), code(VetowallError::TooEarly));
}

#[test]
fn guardian_veto_stops_the_drift_replay() {
    let mut env = setup();
    let (mint, ata) = fake_collateral(&mut env);
    let list = admin_ix(env.vault, env.authority, mock_vault::instruction::ListCollateral { mint, price: 1_000 * USDC, weight_bps: 10_000 }.data());
    let raise = admin_ix(env.vault, env.authority, mock_vault::instruction::SetWithdrawLimit { withdraw_limit: 20 * LIMIT }.data());
    tx!(env, [queue_ix(&env, &list)], [&env.proposer]).unwrap();
    tx!(env, [queue_ix(&env, &raise)], [&env.proposer]).unwrap();

    let guardian = env.guardian.insecure_clone();
    assert_err(tx!(env, [veto_ix(&env, 0, env.attacker.pubkey())], [&env.attacker.insecure_clone()]), code(VetowallError::NotGuardian));
    tx!(env, [veto_ix(&env, 0, guardian.pubkey()), veto_ix(&env, 1, guardian.pubkey())], [&guardian]).unwrap();
    assert_eq!(load::<Proposal>(&env.svm, &proposal_pda(&env, 0)).status, ProposalStatus::Vetoed);

    warp(&mut env.svm, 48 * HOUR);
    assert_err(tx!(env, [execute_ix(&env, 0, &list)], [&env.payer]), code(VetowallError::NotQueued));
    assert_err(tx!(env, [execute_ix(&env, 1, &raise)], [&env.payer]), code(VetowallError::NotQueued));

    let (vault, reserve) = (env.vault, env.reserve);
    assert_eq!(drain(&mut env, vault, reserve, mint, ata), 0);
    assert_eq!(token_balance(&env.svm, &env.reserve), RESERVE);
}

#[test]
fn guardian_can_pause_but_nothing_else() {
    let mut env = setup();
    let guardian = env.guardian.insecure_clone();
    let pause = admin_ix(env.vault, env.authority, mock_vault::instruction::Pause {}.data());
    tx!(env, [guardian_execute_ix(&env, &pause)], [&guardian]).unwrap();
    assert!(load::<mock_vault::Vault>(&env.svm, &env.vault).paused);

    let unpause = admin_ix(env.vault, env.authority, mock_vault::instruction::Unpause {}.data());
    assert_err(tx!(env, [guardian_execute_ix(&env, &unpause)], [&guardian]), code(VetowallError::NotSafeClass));
    let raise = admin_ix(env.vault, env.authority, mock_vault::instruction::SetWithdrawLimit { withdraw_limit: u64::MAX }.data());
    assert_err(tx!(env, [guardian_execute_ix(&env, &raise)], [&guardian]), code(VetowallError::NotSafeClass));
}

#[test]
fn config_changes_take_the_max_timelock_and_the_guardian_cannot_block_its_rotation() {
    let mut env = setup();
    let new_guardian = Pubkey::new_unique();
    let rotate = Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::SetGuardian { guardian: new_guardian }.data(),
        vetowall::accounts::Govern { config: env.config, governor: env.authority }.to_account_metas(None),
    );

    // After sealing, the old admin and the guardian have no direct power.
    for signer in [env.payer.insecure_clone(), env.guardian.insecure_clone()] {
        let direct = Instruction::new_with_bytes(
            vetowall::id(),
            &vetowall::instruction::SetGuardian { guardian: signer.pubkey() }.data(),
            vetowall::accounts::Govern { config: env.config, governor: signer.pubkey() }.to_account_metas(None),
        );
        assert_err(tx!(env, [direct], [&signer]), code(VetowallError::NotGovernor));
    }

    tx!(env, [queue_ix(&env, &rotate)], [&env.proposer]).unwrap();
    let p: Proposal = load(&env.svm, &proposal_pda(&env, 0));
    assert_eq!((p.class, p.eta - p.queued_at), (ActionClass::Max, 7 * DAY));

    let guardian = env.guardian.insecure_clone();
    assert_err(tx!(env, [veto_ix(&env, 0, guardian.pubkey())], [&guardian]), code(VetowallError::GuardianCannotVetoGovernance));

    warp(&mut env.svm, 7 * DAY);
    tx!(env, [execute_ix(&env, 0, &rotate)], [&env.payer]).unwrap();
    assert_eq!(load::<Config>(&env.svm, &env.config).guardian, new_guardian);
}

#[test]
fn only_the_proposer_queues_and_only_the_authority_signs() {
    let mut env = setup();
    let attacker = env.attacker.insecure_clone();
    let takeover = admin_ix(env.vault, env.authority, mock_vault::instruction::SetAdmin { new_admin: attacker.pubkey() }.data());
    let mut forged = queue_ix(&env, &takeover);
    forged.accounts[1] = AccountMeta::new(attacker.pubkey(), true);
    assert_err(tx!(env, [forged], [&attacker]), code(VetowallError::NotProposer));

    // A stored instruction may not ask for any signer besides the authority PDA.
    let foreign = admin_ix(env.vault, attacker.pubkey(), mock_vault::instruction::Pause {}.data());
    assert_err(tx!(env, [queue_ix(&env, &foreign)], [&env.proposer]), code(VetowallError::ForeignSigner));

    // Passing some other account as the policy can't downgrade the class.
    let mut wrong_policy = queue_ix(&env, &takeover);
    let pause = admin_ix(env.vault, env.authority, mock_vault::instruction::Pause {}.data());
    wrong_policy.accounts[5] = AccountMeta::new_readonly(policy_pda(&env.config, &pause), false);
    assert_err(tx!(env, [wrong_policy], [&env.proposer]), code(VetowallError::BadPolicyAccount));
}

#[test]
fn guardian_can_veto_config_changes_other_than_its_own_rotation() {
    let mut env = setup();
    let attacker = env.attacker.pubkey();
    // With the proposer compromised, the first move is to take over the config itself.
    let takeover = Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::SetProposer { proposer: attacker }.data(),
        vetowall::accounts::Govern { config: env.config, governor: env.authority }.to_account_metas(None),
    );
    tx!(env, [queue_ix(&env, &takeover)], [&env.proposer]).unwrap();

    let guardian = env.guardian.insecure_clone();
    tx!(env, [veto_ix(&env, 0, guardian.pubkey())], [&guardian]).unwrap();
    warp(&mut env.svm, 7 * DAY);
    assert_err(tx!(env, [execute_ix(&env, 0, &takeover)], [&env.payer]), code(VetowallError::NotQueued));
    assert_ne!(load::<Config>(&env.svm, &env.config).proposer, attacker);
}

#[test]
fn a_matured_proposal_expires_after_the_grace_period() {
    let mut env = setup();
    let rotate = Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::SetGuardian { guardian: Pubkey::new_unique() }.data(),
        vetowall::accounts::Govern { config: env.config, governor: env.authority }.to_account_metas(None),
    );
    let old_guardian = env.guardian.pubkey();
    tx!(env, [queue_ix(&env, &rotate)], [&env.proposer]).unwrap();
    tx!(env, [queue_ix(&env, &rotate)], [&env.proposer]).unwrap();

    // The last second of the grace period still works.
    warp(&mut env.svm, 7 * DAY + vetowall::GRACE);
    tx!(env, [execute_ix(&env, 0, &rotate)], [&env.payer]).unwrap();
    assert_ne!(load::<Config>(&env.svm, &env.config).guardian, old_guardian);

    // One second later, the identical proposal that nobody executed is dead.
    warp(&mut env.svm, 1);
    assert_err(tx!(env, [execute_ix(&env, 1, &rotate)], [&env.payer]), code(VetowallError::Expired));
}
