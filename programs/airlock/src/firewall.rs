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
    state::{ActionClass, Config, Policy, StoredMeta},
};

/// Refuses to run inside a durable-nonce transaction.
///
/// The runtime only accepts a durable-nonce transaction if its first top-level
/// instruction is `AdvanceNonceAccount`. The Instructions sysvar always lists
/// top-level instructions, even when Airlock is reached by CPI (from a Squads
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

/// The first 8 bytes of instruction data, zero-padded. That is the whole
/// discriminator for Anchor programs.
// ponytail: native programs with 1- or 4-byte tags followed by args get one
// policy per (tag, leading args) prefix; add a per-policy prefix length if a
// real target needs it.
pub fn discriminator(data: &[u8]) -> [u8; 8] {
    let mut out = [0u8; 8];
    let n = data.len().min(8);
    out[..n].copy_from_slice(&data[..n]);
    out
}

pub fn policy_address(config: &Pubkey, target_program: &Pubkey, disc: &[u8; 8]) -> Pubkey {
    Pubkey::find_program_address(
        &[POLICY_SEED, config.as_ref(), target_program.as_ref(), disc],
        &crate::ID,
    )
    .0
}

/// Looks up the class of an instruction. Anything unregistered is `Max`, and
/// so is every instruction that targets Airlock itself.
pub fn resolve_class(
    config: &Pubkey,
    target_program: &Pubkey,
    data: &[u8],
    policy: &AccountInfo,
) -> Result<ActionClass> {
    if *target_program == crate::ID {
        return Ok(ActionClass::Max);
    }
    let expected = policy_address(config, target_program, &discriminator(data));
    require_keys_eq!(policy.key(), expected, ErrorCode::BadPolicyAccount);
    if policy.owner != &crate::ID || policy.data_is_empty() {
        return Ok(ActionClass::Max);
    }
    let policy = Policy::try_deserialize(&mut &policy.try_borrow_data()?[..])?;
    Ok(policy.class)
}

/// Bounds a stored instruction, and makes sure the authority PDA is the only
/// signer it can ask for. Airlock can't produce any other signature at
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
