//! The checks every privileged path goes through.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
    system_program,
};
use solana_instructions_sysvar::load_instruction_at_checked;

use crate::{
    constants::*,
    error::ErrorCode,
    state::{ActionClass, Config, Limit, Policy, Reserve, StoredMeta, Target},
};

/// Refuses to run inside a durable-nonce transaction.
///
/// The runtime only accepts a durable-nonce transaction if its first top-level
/// instruction is `AdvanceNonceAccount`. The Instructions sysvar always lists
/// top-level instructions, even when Vetowall is reached by CPI (from a Squads
/// vault transaction, say), so checking index 0 covers every route in. This is
/// what stops a payload signed today from being executed days later, which is
/// how the Drift admin takeover worked.
pub fn forbid_durable_nonce(instructions_sysvar: &AccountInfo) -> Result<()> {
    let first = load_instruction_at_checked(0, instructions_sysvar)?;
    let is_advance_nonce = first.program_id == system_program::ID
        && first.data.get(..4) == Some(&ADVANCE_NONCE_TAG[..]);
    require!(!is_advance_nonce, ErrorCode::NonceTxForbidden);
    Ok(())
}

/// The policy key for an instruction: the first `disc_len` bytes of its data,
/// or the first 2 when `disc_len == 1` and the first byte is a wide tag,
/// zero-padded to 8.
// ponytail: a wide tag's sub-tag 0 shares its address with the bare 1-byte
// tag, so a 1-byte policy for a wide tag acts as the sub-tag-0 policy. Fine
// for Token-2022, where sub-tag 0 is always `Initialize` and runs before the
// authority is handed over.
pub fn discriminator(data: &[u8], disc_len: u8, wide_tags: &[u8]) -> [u8; 8] {
    let n = match data.first() {
        Some(tag) if disc_len == 1 && wide_tags.contains(tag) => 2,
        _ => usize::from(disc_len),
    };
    let n = n.min(data.len()).min(8);
    let mut out = [0u8; 8];
    out[..n].copy_from_slice(&data[..n]);
    out
}

pub fn target_address(config: &Pubkey, target_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[TARGET_SEED, config.as_ref(), target_program.as_ref()],
        &crate::ID,
    )
    .0
}

pub fn policy_address(config: &Pubkey, target_program: &Pubkey, disc: &[u8; 8]) -> Pubkey {
    Pubkey::find_program_address(
        &[POLICY_SEED, config.as_ref(), target_program.as_ref(), disc],
        &crate::ID,
    )
    .0
}

/// Deserializes one of our accounts, or `None` if it hasn't been created.
fn load_if_exists<T: AccountDeserialize>(account: &AccountInfo) -> Result<Option<T>> {
    if account.owner != &crate::ID || account.data_is_empty() {
        return Ok(None);
    }
    Ok(Some(T::try_deserialize(&mut &account.try_borrow_data()?[..])?))
}

/// Finds the policy for an instruction. `None` means the instruction is
/// unregistered, which is class `Max`; so is every instruction that targets
/// Vetowall itself. The caller picks the accounts, so both addresses are
/// checked: a missing account can only make the class stricter, but a wrong
/// one could make it looser.
pub fn resolve_policy(
    config: &Pubkey,
    target_program: &Pubkey,
    data: &[u8],
    target: &AccountInfo,
    policy: &AccountInfo,
) -> Result<Option<Policy>> {
    if *target_program == crate::ID {
        return Ok(None);
    }
    require_keys_eq!(
        target.key(),
        target_address(config, target_program),
        ErrorCode::BadPolicyAccount
    );
    let Some(target) = load_if_exists::<Target>(target)? else {
        return Ok(None);
    };
    let disc = discriminator(data, target.disc_len, &target.wide_tags);
    require_keys_eq!(
        policy.key(),
        policy_address(config, target_program, &disc),
        ErrorCode::BadPolicyAccount
    );
    load_if_exists::<Policy>(policy)
}

pub fn class_of(policy: &Option<Policy>) -> ActionClass {
    policy.as_ref().map_or(ActionClass::Max, |p| p.class)
}

/// A little-endian u64 at `offset`.
pub fn read_amount(data: &[u8], offset: u8) -> Result<u64> {
    let start = usize::from(offset);
    data.get(start..start + 8)
        .and_then(|b| <[u8; 8]>::try_from(b).ok())
        .map(u64::from_le_bytes)
        .ok_or_else(|| error!(ErrorCode::BadAmount))
}

/// Spends `amount` from the policy's fast-lane cap. The window is fixed: it
/// starts at the first spend after the previous one expired.
pub fn charge_cap(policy: &mut Policy, limit: &Limit, amount: u64, now: i64) -> Result<()> {
    if now >= policy.window_start.saturating_add(limit.window) {
        policy.window_start = now;
        policy.used = 0;
    }
    policy.used = policy
        .used
        .checked_add(amount)
        .filter(|used| *used <= limit.cap)
        .ok_or(ErrorCode::OverCap)?;
    Ok(())
}

/// Supply after the instruction must stay within a fresh attestation of
/// reserves. `instruction_accounts` are the remaining accounts, in the same
/// order as the stored metas.
pub fn check_reserve(
    limit: &Limit,
    amount: u64,
    metas: &[StoredMeta],
    instruction_accounts: &[AccountInfo],
    reserve: Option<&Account<Reserve>>,
) -> Result<()> {
    let Some(expected) = limit.reserve else {
        return Ok(());
    };
    let reserve = reserve.ok_or(ErrorCode::BadReserveAccount)?;
    require_keys_eq!(reserve.key(), expected, ErrorCode::BadReserveAccount);

    let i = usize::from(limit.mint_index);
    let (Some(meta), Some(mint)) = (metas.get(i), instruction_accounts.get(i)) else {
        return err!(ErrorCode::BadReserveAccount);
    };
    require_keys_eq!(mint.key(), meta.pubkey, ErrorCode::BadReserveAccount);
    require_keys_eq!(mint.key(), reserve.mint, ErrorCode::BadReserveAccount);
    require!(
        *mint.owner == TOKEN_PROGRAM_ID || *mint.owner == TOKEN_2022_PROGRAM_ID,
        ErrorCode::BadReserveAccount
    );

    let age = Clock::get()?.unix_timestamp.saturating_sub(reserve.updated_at);
    require!(age <= reserve.max_age, ErrorCode::StaleReserve);
    let supply = read_amount(&mint.try_borrow_data()?, MINT_SUPPLY_OFFSET)?;
    require!(
        supply
            .checked_add(amount)
            .is_some_and(|total| total <= reserve.amount),
        ErrorCode::OverReserves
    );
    Ok(())
}

/// Bounds a stored instruction, and makes sure the authority PDA is the only
/// signer it can ask for. Vetowall can't produce any other signature at
/// execute time, so another signer would only make the proposal unexecutable.
pub fn validate_instruction(
    config: &Config,
    config_key: &Pubkey,
    accounts: &[StoredMeta],
    data: &[u8],
) -> Result<()> {
    require!(accounts.len() <= MAX_ACCOUNTS, ErrorCode::TooManyAccounts);
    require!(data.len() <= MAX_DATA, ErrorCode::DataTooLarge);
    let authority = config.authority(config_key)?;
    require!(
        accounts.iter().all(|m| !m.is_signer || m.pubkey == authority),
        ErrorCode::ForeignSigner
    );
    Ok(())
}

/// CPIs into the target program with the authority PDA as signer. The caller
/// passes every account the instruction names (and the target program) as
/// remaining accounts; the runtime matches them by key.
pub fn invoke_as_authority(
    config: &Config,
    config_key: &Pubkey,
    target_program: Pubkey,
    accounts: &[StoredMeta],
    data: Vec<u8>,
    account_infos: &[AccountInfo],
) -> Result<()> {
    let ix = Instruction {
        program_id: target_program,
        accounts: accounts
            .iter()
            .map(|m| AccountMeta {
                pubkey: m.pubkey,
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data,
    };
    invoke_signed(
        &ix,
        account_infos,
        &[&[AUTHORITY_SEED, config_key.as_ref(), &[config.authority_bump]]],
    )?;
    Ok(())
}
