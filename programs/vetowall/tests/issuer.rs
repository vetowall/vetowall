//! A stablecoin issuer on Token-2022 with every authority handed to Vetowall:
//! daily-capped mints in the fast lane, larger ones behind the timelock,
//! supply bounded by attested reserves on both paths, maker-checker
//! signatures, and Pausable's 2-byte instructions resolving to their own
//! policies.

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AnchorDeserialize, AccountDeserialize, Discriminator, InstructionData, ToAccountMetas,
        __private::base64::{engine::general_purpose::STANDARD as B64, Engine},
    },
    litesvm::{types::{FailedTransactionMetadata, TransactionMetadata}, LiteSVM},
    litesvm_token::{get_spl_account, CreateAssociatedTokenAccount},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    spl_token_2022_interface::{
        self as t22,
        extension::{pausable::PausableConfig, BaseStateWithExtensions, ExtensionType, StateWithExtensions},
        state::{Account as TokenAccount, AccountState, Mint},
    },
    vetowall::{error::ErrorCode as VetowallError, ActionClass, ChangeRecord, RecordKind, Limit, Policy, Proposal, ProposalStatus, StoredMeta, Target},
};

const HOUR: i64 = 3600;
const DAY: i64 = 24 * HOUR;
const DELAYS: [i64; 4] = [0, 48 * HOUR, 72 * HOUR, 7 * DAY];
const USD: u64 = 1_000_000;
/// Fast-lane mint cap per day.
const CAP: u64 = 1_000_000 * USD;
const RESERVES: u64 = 10_000_000 * USD;

// Token instruction tags (spl-token-2022-interface `TokenInstruction`).
const MINT_TO: u8 = 7;
const FREEZE_ACCOUNT: u8 = 10;
const PAUSABLE: u8 = 44;
const PAUSE: u8 = 1;
const RESUME: u8 = 2;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    proposer: Keypair,
    approver: Keypair,
    guardian: Keypair,
    attestor: Keypair,
    attacker: Keypair,
    config: Pubkey,
    authority: Pubkey,
    mint: Pubkey,
    holder: Pubkey,
    reserve: Pubkey,
}

type Sent = Result<TransactionMetadata, FailedTransactionMetadata>;

fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> Sent {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    let res = svm.send_transaction(tx);
    svm.expire_blockhash();
    res
}

macro_rules! tx {
    ($env:expr, [$($ix:expr),* $(,)?], [$($signer:expr),* $(,)?]) => {{
        let ixs = vec![$($ix),*];
        send(&mut $env.svm, &ixs, &[$($signer),*])
    }};
}

fn assert_err<T: std::fmt::Debug>(res: Result<T, FailedTransactionMetadata>, e: VetowallError) {
    let code = u32::from(e);
    let err = res.expect_err("transaction should have failed").err;
    let got = format!("{err:?}");
    assert!(got.contains(&format!("Custom({code})")), "expected custom error {code}, got {got}");
}

fn warp(svm: &mut LiteSVM, seconds: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp += seconds;
    clock.slot += (seconds as u64) * 2;
    svm.set_sysvar(&clock);
}

fn load<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let account = svm.get_account(key).unwrap();
    T::try_deserialize(&mut &account.data[..]).unwrap()
}

fn stored(ix: &Instruction) -> Vec<StoredMeta> {
    ix.accounts
        .iter()
        .map(|m| StoredMeta { pubkey: m.pubkey, is_signer: m.is_signer, is_writable: m.is_writable })
        .collect()
}

fn remaining(target: &Instruction) -> Vec<AccountMeta> {
    let mut metas: Vec<AccountMeta> = target
        .accounts
        .iter()
        .map(|m| AccountMeta { pubkey: m.pubkey, is_signer: false, is_writable: m.is_writable })
        .collect();
    metas.push(AccountMeta::new_readonly(target.program_id, false));
    metas
}

fn target_pda(env: &Env) -> Pubkey {
    vetowall::firewall::target_address(&env.config, &t22::ID)
}

/// What a client does: read the Target, then derive the policy address the
/// program will expect.
fn policy_for(env: &Env, data: &[u8]) -> Pubkey {
    let (disc_len, wide) = match env.svm.get_account(&target_pda(env)) {
        Some(a) if !a.data.is_empty() => {
            let t = Target::try_deserialize(&mut &a.data[..]).unwrap();
            (t.disc_len, t.wide_tags)
        }
        _ => (1, vec![]),
    };
    let disc = vetowall::firewall::discriminator(data, disc_len, &wide);
    vetowall::firewall::policy_address(&env.config, &t22::ID, &disc)
}

fn disc(bytes: &[u8]) -> [u8; 8] {
    let mut d = [0u8; 8];
    d[..bytes.len()].copy_from_slice(bytes);
    d
}

fn register_ix(env: &Env, bytes: &[u8], class: ActionClass, limit: Option<Limit>) -> Instruction {
    let discriminator = disc(bytes);
    Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Register { target_program: t22::ID, discriminator, disc_len: 1, class, limit }.data(),
        vetowall::accounts::Register {
            config: env.config,
            governor: env.admin.pubkey(),
            target: target_pda(env),
            policy: vetowall::firewall::policy_address(&env.config, &t22::ID, &discriminator),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn queue_ix(env: &Env, target: &Instruction, approver: Option<Pubkey>) -> Instruction {
    let id = load::<vetowall::Config>(&env.svm, &env.config).proposal_count;
    Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Queue { target_program: target.program_id, accounts: stored(target), data: target.data.clone() }.data(),
        vetowall::accounts::Queue {
            config: env.config,
            proposer: env.proposer.pubkey(),
            approver,
            proposal: proposal_pda(env, id),
            target: target_pda(env),
            policy: policy_for(env, &target.data),
            instructions: solana_instructions_sysvar::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn proposal_pda(env: &Env, id: u64) -> Pubkey {
    Pubkey::find_program_address(&[vetowall::PROPOSAL_SEED, env.config.as_ref(), &id.to_le_bytes()], &vetowall::id()).0
}

fn execute_ix(env: &Env, id: u64, target: &Instruction, reserve: Option<Pubkey>) -> Instruction {
    let mut metas = vetowall::accounts::Execute {
        config: env.config,
        proposal: proposal_pda(env, id),
        target: target_pda(env),
        policy: policy_for(env, &target.data),
        reserve,
        instructions: solana_instructions_sysvar::ID,
    }
    .to_account_metas(None);
    metas.extend(remaining(target));
    Instruction::new_with_bytes(vetowall::id(), &vetowall::instruction::Execute {}.data(), metas)
}

fn execute_now_ix(env: &Env, target: &Instruction, approver: Option<Pubkey>, reserve: Option<Pubkey>) -> Instruction {
    let mut metas = vetowall::accounts::ExecuteNow {
        config: env.config,
        proposer: env.proposer.pubkey(),
        approver,
        target: target_pda(env),
        policy: policy_for(env, &target.data),
        reserve,
        instructions: solana_instructions_sysvar::ID,
    }
    .to_account_metas(None);
    metas.extend(remaining(target));
    Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::ExecuteNow { target_program: target.program_id, accounts: stored(target), data: target.data.clone() }.data(),
        metas,
    )
}

fn guardian_execute_ix(env: &Env, target: &Instruction) -> Instruction {
    let mut metas = vetowall::accounts::GuardianExecute {
        config: env.config,
        guardian: env.guardian.pubkey(),
        target: target_pda(env),
        policy: policy_for(env, &target.data),
        instructions: solana_instructions_sysvar::ID,
    }
    .to_account_metas(None);
    metas.extend(remaining(target));
    Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::GuardianExecute { target_program: target.program_id, accounts: stored(target), data: target.data.clone() }.data(),
        metas,
    )
}

fn attest_ix(env: &Env, attestor: Pubkey, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::AttestReserve { amount }.data(),
        vetowall::accounts::AttestReserve { reserve: env.reserve, attestor, instructions: solana_instructions_sysvar::ID }
            .to_account_metas(None),
    )
}

fn mint_ix(env: &Env, amount: u64) -> Instruction {
    t22::instruction::mint_to(&t22::ID, &env.mint, &env.holder, &env.authority, &[], amount).unwrap()
}

fn supply(env: &Env) -> u64 {
    get_spl_account::<Mint>(&env.svm, &env.mint).unwrap().supply
}

fn paused(env: &Env) -> bool {
    let account = env.svm.get_account(&env.mint).unwrap();
    let mint = StateWithExtensions::<Mint>::unpack(&account.data).unwrap();
    bool::from(mint.get_extension::<PausableConfig>().unwrap().paused)
}

/// A Token-2022 mint with the Pausable extension, whose mint, freeze and
/// pause authorities are all Vetowall's authority PDA from the start.
fn create_mint(svm: &mut LiteSVM, payer: &Keypair, authority: &Pubkey) -> Pubkey {
    let mint = Keypair::new();
    let len = ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::Pausable]).unwrap();
    let ixs = [
        solana_system_interface::instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            svm.minimum_balance_for_rent_exemption(len),
            len as u64,
            &t22::ID,
        ),
        t22::extension::pausable::instruction::initialize(&t22::ID, &mint.pubkey(), authority).unwrap(),
        t22::instruction::initialize_mint2(&t22::ID, &mint.pubkey(), authority, Some(authority), 6).unwrap(),
    ];
    send(svm, &ixs, &[payer, &mint]).unwrap();
    mint.pubkey()
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(vetowall::id(), include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/vetowall.so")))
        .unwrap();
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = 1_790_000_000; // Sep 2026
    svm.set_sysvar(&clock);

    let [admin, proposer, approver, guardian, attestor, attacker] = std::array::from_fn(|_| Keypair::new());
    for k in [&admin, &proposer, &approver, &guardian, &attestor, &attacker] {
        svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    }
    let config_kp = Keypair::new();
    let config = config_kp.pubkey();
    let authority = Pubkey::find_program_address(&[vetowall::AUTHORITY_SEED, config.as_ref()], &vetowall::id()).0;
    svm.airdrop(&authority, 1_000_000_000).unwrap();

    let mint = create_mint(&mut svm, &admin, &authority);
    let holder = CreateAssociatedTokenAccount::new(&mut svm, &admin, &mint)
        .owner(&Keypair::new().pubkey())
        .token_program_id(&t22::ID)
        .send()
        .unwrap();
    let reserve = Pubkey::find_program_address(&[vetowall::RESERVE_SEED, config.as_ref(), mint.as_ref()], &vetowall::id()).0;

    let mut env = Env { svm, admin, proposer, approver, guardian, attestor, attacker, config, authority, mint, holder, reserve };

    let init = Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Initialize {
            proposer: env.proposer.pubkey(),
            approver: Some(env.approver.pubkey()),
            guardian: env.guardian.pubkey(),
            delays: DELAYS,
        }
        .data(),
        vetowall::accounts::Initialize { admin: env.admin.pubkey(), config, system_program: system_program::ID }
            .to_account_metas(None),
    );
    tx!(env, [init], [&env.admin, &config_kp]).unwrap();

    let init_reserve = Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::InitReserve { mint, attestor: env.attestor.pubkey(), max_age: DAY }.data(),
        vetowall::accounts::InitReserve { config, governor: env.admin.pubkey(), reserve, system_program: system_program::ID }
            .to_account_metas(None),
    );
    tx!(env, [init_reserve], [&env.admin]).unwrap();

    // The issuer policy pack from SPEC.md.
    let mint_limit = Limit { amount_offset: 1, cap: CAP, window: DAY, reserve: Some(reserve), mint_index: 0 };
    let policies: [(&[u8], ActionClass, Option<Limit>); 4] = [
        (&[MINT_TO], ActionClass::Params, Some(mint_limit)),
        (&[FREEZE_ACCOUNT], ActionClass::Params, None),
        (&[PAUSABLE, PAUSE], ActionClass::Safe, None),
        (&[PAUSABLE, RESUME], ActionClass::Params, None),
    ];
    for (bytes, class, limit) in policies {
        tx!(env, [register_ix(&env, bytes, class, limit)], [&env.admin]).unwrap();
    }
    let seal = Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Seal {}.data(),
        vetowall::accounts::Seal { config, admin: env.admin.pubkey() }.to_account_metas(None),
    );
    tx!(env, [seal], [&env.admin]).unwrap();
    attest(&mut env, RESERVES);
    env
}

fn attest(env: &mut Env, amount: u64) {
    let attestor = env.attestor.insecure_clone();
    tx!(env, [attest_ix(env, attestor.pubkey(), amount)], [&attestor]).unwrap();
}

/// Sends `ix` through the fast lane with both signatures and the reserve.
fn fast(env: &mut Env, ix: &Instruction) -> Sent {
    let (p, a) = (env.proposer.insecure_clone(), env.approver.insecure_clone());
    tx!(env, [execute_now_ix(env, ix, Some(a.pubkey()), Some(env.reserve))], [&p, &a])
}

fn mint_now(env: &mut Env, amount: u64) -> Sent {
    let ix = mint_ix(env, amount);
    fast(env, &ix)
}

/// The `ChangeRecord` events in a transaction's `Program data:` log lines.
fn records(meta: &TransactionMetadata) -> Vec<ChangeRecord> {
    meta.logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b64| B64.decode(b64).ok())
        .filter(|d| d.starts_with(ChangeRecord::DISCRIMINATOR))
        .map(|d| ChangeRecord::try_from_slice(&d[8..]).unwrap())
        .collect()
}

fn one_record(meta: TransactionMetadata) -> ChangeRecord {
    let mut all = records(&meta);
    assert_eq!(all.len(), 1, "{all:?}");
    all.remove(0)
}

fn now(env: &Env) -> i64 {
    env.svm.get_sysvar::<Clock>().unix_timestamp
}

fn queue(env: &mut Env, ix: &Instruction) -> u64 {
    let id = load::<vetowall::Config>(&env.svm, &env.config).proposal_count;
    let (p, a) = (env.proposer.insecure_clone(), env.approver.insecure_clone());
    tx!(env, [queue_ix(env, ix, Some(a.pubkey()))], [&p, &a]).unwrap();
    id
}

#[test]
fn mint_within_cap_runs_instantly() {
    let mut env = setup();
    let mint = mint_ix(&env, 400_000 * USD);
    fast(&mut env, &mint).unwrap();
    assert_eq!(supply(&env), 400_000 * USD);
    let policy: Policy = load(&env.svm, &policy_for(&env, &mint.data));
    assert_eq!(policy.used, 400_000 * USD);

    // A limited policy can't skip its reserve by leaving the account out.
    let (p, a) = (env.proposer.insecure_clone(), env.approver.insecure_clone());
    assert_err(tx!(env, [execute_now_ix(&env, &mint, Some(a.pubkey()), None)], [&p, &a]), VetowallError::BadReserveAccount);
}

#[test]
fn over_cap_mint_waits_out_the_timelock() {
    let mut env = setup();
    let big = mint_ix(&env, CAP + 1);
    assert_err(fast(&mut env, &big), VetowallError::OverCap);
    assert_eq!(supply(&env), 0);

    let id = queue(&mut env, &big);
    let p: Proposal = load(&env.svm, &proposal_pda(&env, id));
    assert_eq!((p.class, p.amount, p.eta - p.queued_at), (ActionClass::Params, Some(CAP + 1), 48 * HOUR));
    assert_err(tx!(env, [execute_ix(&env, id, &big, Some(env.reserve))], [&env.admin]), VetowallError::TooEarly);

    warp(&mut env.svm, 48 * HOUR);
    attest(&mut env, RESERVES); // the 1-day attestation went stale while it waited
    tx!(env, [execute_ix(&env, id, &big, Some(env.reserve))], [&env.admin]).unwrap();
    assert_eq!(supply(&env), CAP + 1);
}

#[test]
fn mint_above_attested_reserves_fails_on_both_paths() {
    let mut env = setup();
    attest(&mut env, 500_000 * USD);
    let mint = mint_ix(&env, 600_000 * USD);
    assert_err(fast(&mut env, &mint), VetowallError::OverReserves);

    let id = queue(&mut env, &mint);
    warp(&mut env.svm, 48 * HOUR);
    attest(&mut env, 500_000 * USD);
    assert_err(tx!(env, [execute_ix(&env, id, &mint, Some(env.reserve))], [&env.admin]), VetowallError::OverReserves);
    assert_eq!(load::<Proposal>(&env.svm, &proposal_pda(&env, id)).status, ProposalStatus::Queued);
    assert_eq!(supply(&env), 0);

    // Existing supply counts: 400k fits, another 200k doesn't.
    mint_now(&mut env, 400_000 * USD).unwrap();
    assert_err(mint_now(&mut env, 200_000 * USD), VetowallError::OverReserves);
    // Over both the cap and reserves: reported as unbacked.
    assert_err(mint_now(&mut env, 2 * CAP), VetowallError::OverReserves);
}

#[test]
fn stale_attestation_is_refused() {
    let mut env = setup();
    warp(&mut env.svm, DAY + 1);
    assert_err(mint_now(&mut env, USD), VetowallError::StaleReserve);
    attest(&mut env, RESERVES);
    mint_now(&mut env, USD).unwrap();
}

#[test]
fn cap_window_resets_after_a_day() {
    let mut env = setup();
    mint_now(&mut env, CAP).unwrap();
    assert_err(mint_now(&mut env, 1), VetowallError::OverCap);

    warp(&mut env.svm, DAY - 60);
    attest(&mut env, RESERVES);
    assert_err(mint_now(&mut env, 1), VetowallError::OverCap);

    warp(&mut env.svm, 60);
    mint_now(&mut env, CAP).unwrap();
    assert_eq!(supply(&env), 2 * CAP);
}

#[test]
fn missing_approver_signature_fails() {
    let mut env = setup();
    let mint = mint_ix(&env, USD);
    let proposer = env.proposer.insecure_clone();
    assert_err(tx!(env, [execute_now_ix(&env, &mint, None, Some(env.reserve))], [&proposer]), VetowallError::NotApprover);
    assert_err(tx!(env, [queue_ix(&env, &mint, None)], [&proposer]), VetowallError::NotApprover);

    // Some other signer in the approver slot doesn't count either.
    let attacker = env.attacker.insecure_clone();
    assert_err(
        tx!(env, [execute_now_ix(&env, &mint, Some(attacker.pubkey()), Some(env.reserve))], [&proposer, &attacker]),
        VetowallError::NotApprover,
    );
    assert_eq!(supply(&env), 0);
}

#[test]
fn only_the_attestor_can_attest() {
    let mut env = setup();
    for signer in [env.attacker.insecure_clone(), env.admin.insecure_clone(), env.proposer.insecure_clone()] {
        assert_err(tx!(env, [attest_ix(&env, signer.pubkey(), u64::MAX)], [&signer]), VetowallError::NotAttestor);
    }
    attest(&mut env, 42);
    assert_eq!(load::<vetowall::Reserve>(&env.svm, &env.reserve).amount, 42);
}

#[test]
fn freeze_goes_through_the_params_timelock() {
    let mut env = setup();
    let freeze = t22::instruction::freeze_account(&t22::ID, &env.holder, &env.mint, &env.authority, &[]).unwrap();
    assert_err(fast(&mut env, &freeze), VetowallError::NotFastLane);

    let id = queue(&mut env, &freeze);
    let p: Proposal = load(&env.svm, &proposal_pda(&env, id));
    assert_eq!((p.class, p.amount, p.eta - p.queued_at), (ActionClass::Params, None, 48 * HOUR));

    warp(&mut env.svm, 48 * HOUR);
    tx!(env, [execute_ix(&env, id, &freeze, None)], [&env.admin]).unwrap();
    let account = get_spl_account::<TokenAccount>(&env.svm, &env.holder).unwrap();
    assert_eq!(account.state, AccountState::Frozen);
}

/// Pause and Resume are both tag 44; only the second byte tells them apart.
#[test]
fn pausable_sub_instructions_resolve_to_their_own_policies() {
    let mut env = setup();
    let target: Target = load(&env.svm, &target_pda(&env));
    assert_eq!((target.disc_len, target.wide_tags), (1, vec![PAUSABLE]));

    let pause = t22::extension::pausable::instruction::pause(&t22::ID, &env.mint, &env.authority, &[]).unwrap();
    let resume = t22::extension::pausable::instruction::resume(&t22::ID, &env.mint, &env.authority, &[]).unwrap();
    assert_eq!((&pause.data[..], &resume.data[..]), (&[PAUSABLE, PAUSE][..], &[PAUSABLE, RESUME][..]));
    assert_ne!(policy_for(&env, &pause.data), policy_for(&env, &resume.data));

    let guardian = env.guardian.insecure_clone();
    tx!(env, [guardian_execute_ix(&env, &pause)], [&guardian]).unwrap();
    assert!(paused(&env));
    assert_err(tx!(env, [guardian_execute_ix(&env, &resume)], [&guardian]), VetowallError::NotSafeClass);
    // A limited policy is never the guardian's to run, whatever its class.
    assert_err(tx!(env, [guardian_execute_ix(&env, &mint_ix(&env, 1))], [&guardian]), VetowallError::NotSafeClass);

    let id = queue(&mut env, &resume);
    assert_eq!(load::<Proposal>(&env.svm, &proposal_pda(&env, id)).class, ActionClass::Params);
    warp(&mut env.svm, 48 * HOUR);
    tx!(env, [execute_ix(&env, id, &resume, None)], [&env.admin]).unwrap();
    assert!(!paused(&env));
}

#[test]
fn fast_lane_mint_leaves_a_change_record() {
    let mut env = setup();
    let rec = one_record(mint_now(&mut env, 400_000 * USD).unwrap());
    assert_eq!(
        rec,
        ChangeRecord {
            kind: RecordKind::ExecutedNow,
            config: env.config,
            proposal_id: None,
            target_program: t22::ID,
            discriminator: disc(&[MINT_TO]),
            amount: Some(400_000 * USD),
            class: Some(ActionClass::Params),
            actor: env.proposer.pubkey(),
            approver: Some(env.approver.pubkey()),
            subject: None,
            reason: [0; 32],
            timestamp: now(&env),
        }
    );
}

#[test]
fn queue_and_execute_leave_records_and_executed_at() {
    let mut env = setup();
    let big = mint_ix(&env, CAP + 1);
    let (p, a) = (env.proposer.insecure_clone(), env.approver.insecure_clone());
    let queued = one_record(tx!(env, [queue_ix(&env, &big, Some(a.pubkey()))], [&p, &a]).unwrap());
    assert_eq!(
        (queued.kind, queued.proposal_id, queued.discriminator, queued.amount, queued.class),
        (RecordKind::Queued, Some(0), disc(&[MINT_TO]), Some(CAP + 1), Some(ActionClass::Params))
    );
    assert_eq!((queued.actor, queued.approver), (p.pubkey(), Some(a.pubkey())));
    assert_eq!(load::<Proposal>(&env.svm, &proposal_pda(&env, 0)).executed_at, 0);

    warp(&mut env.svm, 48 * HOUR);
    attest(&mut env, RESERVES);
    let rec = one_record(tx!(env, [execute_ix(&env, 0, &big, Some(env.reserve))], [&env.admin]).unwrap());
    assert_eq!(
        (rec.kind, rec.proposal_id, rec.discriminator, rec.amount, rec.class, rec.actor),
        (RecordKind::Executed, Some(0), disc(&[MINT_TO]), Some(CAP + 1), Some(ActionClass::Params), Pubkey::default())
    );
    assert_eq!(rec.timestamp, now(&env));
    let p: Proposal = load(&env.svm, &proposal_pda(&env, 0));
    assert_eq!((p.status, p.executed_at), (ProposalStatus::Executed, now(&env)));
}

#[test]
fn veto_and_guardian_pause_leave_records() {
    let mut env = setup();
    // SetAuthority has no policy: class Max, discriminator is its 1-byte tag.
    let set_auth = t22::instruction::set_authority(
        &t22::ID,
        &env.mint,
        Some(&env.attacker.pubkey()),
        t22::instruction::AuthorityType::MintTokens,
        &env.authority,
        &[],
    )
    .unwrap();
    let id = queue(&mut env, &set_auth);
    let guardian = env.guardian.insecure_clone();
    let reason = [7u8; 32];
    let veto = Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Veto { reason }.data(),
        vetowall::accounts::Veto { config: env.config, guardian: guardian.pubkey(), proposal: proposal_pda(&env, id) }
            .to_account_metas(None),
    );
    let rec = one_record(tx!(env, [veto], [&guardian]).unwrap());
    assert_eq!(
        rec,
        ChangeRecord {
            kind: RecordKind::Vetoed,
            config: env.config,
            proposal_id: Some(id),
            target_program: t22::ID,
            discriminator: disc(&[6]),
            amount: None,
            class: Some(ActionClass::Max),
            actor: guardian.pubkey(),
            approver: None,
            subject: None,
            reason,
            timestamp: now(&env),
        }
    );

    let pause = t22::extension::pausable::instruction::pause(&t22::ID, &env.mint, &env.authority, &[]).unwrap();
    let rec = one_record(tx!(env, [guardian_execute_ix(&env, &pause)], [&guardian]).unwrap());
    assert_eq!(
        (rec.kind, rec.discriminator, rec.class, rec.actor, rec.proposal_id, rec.amount),
        (RecordKind::GuardianExecuted, disc(&[PAUSABLE, PAUSE]), Some(ActionClass::Safe), guardian.pubkey(), None, None)
    );
}

/// Creates a second, unsealed config in the same VM, so its admin can call
/// the role setters directly. Returns the send result and the config address.
fn fresh_config(env: &mut Env, proposer: Pubkey, approver: Option<Pubkey>, guardian: Pubkey) -> (Sent, Pubkey) {
    let config_kp = Keypair::new();
    let init = Instruction::new_with_bytes(
        vetowall::id(),
        &vetowall::instruction::Initialize { proposer, approver, guardian, delays: DELAYS }.data(),
        vetowall::accounts::Initialize { admin: env.admin.pubkey(), config: config_kp.pubkey(), system_program: system_program::ID }
            .to_account_metas(None),
    );
    (tx!(env, [init], [&env.admin, &config_kp]), config_kp.pubkey())
}

fn govern_ix(env: &Env, config: Pubkey, data: Vec<u8>) -> Instruction {
    Instruction::new_with_bytes(
        vetowall::id(),
        &data,
        vetowall::accounts::Govern { config, governor: env.admin.pubkey() }.to_account_metas(None),
    )
}

#[test]
fn a_config_cannot_be_created_with_one_key_in_two_roles() {
    let mut env = setup();
    let [p, a, g] = std::array::from_fn(|_| Pubkey::new_unique());
    assert_err(fresh_config(&mut env, p, Some(p), g).0, VetowallError::SameRole);
    assert_err(fresh_config(&mut env, p, Some(a), p).0, VetowallError::SameRole);
    assert_err(fresh_config(&mut env, p, Some(a), a).0, VetowallError::SameRole);
    // No approver is the single-signer mode, but the guardian must still differ from the proposer.
    assert_err(fresh_config(&mut env, p, None, p).0, VetowallError::SameRole);
    fresh_config(&mut env, p, None, g).0.unwrap();
    fresh_config(&mut env, p, Some(a), g).0.unwrap();
}

#[test]
fn a_role_cannot_be_changed_to_a_key_that_holds_another() {
    let mut env = setup();
    let [p, a, g, fresh] = std::array::from_fn(|_| Pubkey::new_unique());
    let (res, config) = fresh_config(&mut env, p, Some(a), g);
    res.unwrap();
    let admin = env.admin.insecure_clone();

    for (data, what) in [
        (vetowall::instruction::SetApprover { approver: Some(p) }.data(), "approver = proposer"),
        (vetowall::instruction::SetApprover { approver: Some(g) }.data(), "approver = guardian"),
        (vetowall::instruction::SetProposer { proposer: a }.data(), "proposer = approver"),
        (vetowall::instruction::SetProposer { proposer: g }.data(), "proposer = guardian"),
        (vetowall::instruction::SetGuardian { guardian: p }.data(), "guardian = proposer"),
        (vetowall::instruction::SetGuardian { guardian: a }.data(), "guardian = approver"),
    ] {
        let res = tx!(env, [govern_ix(&env, config, data)], [&admin]);
        assert!(res.is_err(), "{what} should be refused");
        assert_err(res, VetowallError::SameRole);
    }
    // The refusals left the config as it was.
    let c: vetowall::Config = load(&env.svm, &config);
    assert_eq!((c.proposer, c.approver, c.guardian), (p, Some(a), g));

    // Rotating to an unused key, and removing the approver, still work.
    tx!(env, [govern_ix(&env, config, vetowall::instruction::SetGuardian { guardian: fresh }.data())], [&admin]).unwrap();
    tx!(env, [govern_ix(&env, config, vetowall::instruction::SetApprover { approver: None }.data())], [&admin]).unwrap();
    // With the approver gone, its old key is free to become the guardian.
    tx!(env, [govern_ix(&env, config, vetowall::instruction::SetGuardian { guardian: a }.data())], [&admin]).unwrap();
}

#[test]
fn the_attestor_cannot_be_a_signer_of_mints() {
    let mut env = setup();
    let [p, a, g, outsider] = std::array::from_fn(|_| Pubkey::new_unique());
    let (res, config) = fresh_config(&mut env, p, Some(a), g);
    res.unwrap();
    let admin = env.admin.insecure_clone();
    let mint = env.mint;
    let reserve = Pubkey::find_program_address(&[vetowall::RESERVE_SEED, config.as_ref(), mint.as_ref()], &vetowall::id()).0;
    let init_reserve = |attestor: Pubkey| {
        Instruction::new_with_bytes(
            vetowall::id(),
            &vetowall::instruction::InitReserve { mint, attestor, max_age: DAY }.data(),
            vetowall::accounts::InitReserve { config, governor: admin.pubkey(), reserve, system_program: system_program::ID }
                .to_account_metas(None),
        )
    };
    assert_err(tx!(env, [init_reserve(p)], [&admin]), VetowallError::SameRole);
    assert_err(tx!(env, [init_reserve(a)], [&admin]), VetowallError::SameRole);
    // The guardian can't mint, so it may attest.
    tx!(env, [init_reserve(g)], [&admin]).unwrap();

    let set_attestor = |attestor: Pubkey| {
        Instruction::new_with_bytes(
            vetowall::id(),
            &vetowall::instruction::SetAttestor { attestor }.data(),
            vetowall::accounts::SetAttestor { config, governor: admin.pubkey(), reserve }.to_account_metas(None),
        )
    };
    assert_err(tx!(env, [set_attestor(p)], [&admin]), VetowallError::SameRole);
    assert_err(tx!(env, [set_attestor(a)], [&admin]), VetowallError::SameRole);
    tx!(env, [set_attestor(outsider)], [&admin]).unwrap();
    let r: vetowall::Reserve = load(&env.svm, &reserve);
    assert_eq!(r.attestor, outsider);
}
