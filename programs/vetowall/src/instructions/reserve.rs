//! Attested reserves. Governance creates a `Reserve` per mint and names its
//! attestor; the attestor reports the reserve amount; every path that mints
//! under a limited policy keeps supply within it.

use anchor_lang::prelude::*;

use crate::{
    constants::RESERVE_SEED,
    error::ErrorCode,
    event::{ChangeRecord, RecordKind},
    firewall::forbid_durable_nonce,
    state::{Config, Reserve},
};

#[derive(Accounts)]
#[instruction(mint: Pubkey)]
pub struct InitReserve<'info> {
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub governor: Signer<'info>,
    #[account(
        init,
        payer = governor,
        space = 8 + Reserve::INIT_SPACE,
        seeds = [RESERVE_SEED, config.key().as_ref(), mint.as_ref()],
        bump
    )]
    pub reserve: Account<'info, Reserve>,
    pub system_program: Program<'info, System>,
}

/// Starts unattested (`updated_at = 0`), so it is stale until the first
/// attestation and nothing can mint against it.
pub fn handle_init_reserve(
    ctx: Context<InitReserve>,
    mint: Pubkey,
    attestor: Pubkey,
    max_age: i64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    config.require_governor(&config.key(), &ctx.accounts.governor.key())?;
    config.require_independent_attestor(&attestor)?;
    let reserve = &mut ctx.accounts.reserve;
    reserve.config = config.key();
    reserve.mint = mint;
    reserve.attestor = attestor;
    reserve.max_age = max_age;
    emit!(ChangeRecord {
        subject: Some(mint),
        ..ChangeRecord::new(RecordKind::ReserveInitialized, config.key(), ctx.accounts.governor.key())?
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetAttestor<'info> {
    pub config: Account<'info, Config>,
    pub governor: Signer<'info>,
    #[account(mut, has_one = config)]
    pub reserve: Account<'info, Reserve>,
}

pub fn handle_set_attestor(ctx: Context<SetAttestor>, attestor: Pubkey) -> Result<()> {
    let config = &ctx.accounts.config;
    config.require_governor(&config.key(), &ctx.accounts.governor.key())?;
    config.require_independent_attestor(&attestor)?;
    ctx.accounts.reserve.attestor = attestor;
    emit!(ChangeRecord {
        subject: Some(attestor),
        ..ChangeRecord::new(RecordKind::AttestorSet, config.key(), ctx.accounts.governor.key())?
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AttestReserve<'info> {
    #[account(mut, has_one = attestor @ ErrorCode::NotAttestor)]
    pub reserve: Account<'info, Reserve>,
    pub attestor: Signer<'info>,
    /// CHECK: address constraint.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// `updated_at` is stamped when the attestation lands, so a pre-signed
/// durable-nonce attestation would look fresh whenever it was submitted.
/// That is the Drift pattern again, so it is refused here too.
pub fn handle_attest_reserve(ctx: Context<AttestReserve>, amount: u64) -> Result<()> {
    forbid_durable_nonce(&ctx.accounts.instructions)?;
    let reserve = &mut ctx.accounts.reserve;
    reserve.amount = amount;
    reserve.updated_at = Clock::get()?.unix_timestamp;
    msg!("reserve {} attested at {}", reserve.mint, amount);
    emit!(ChangeRecord {
        amount: Some(amount),
        subject: Some(reserve.mint),
        ..ChangeRecord::new(RecordKind::ReserveAttested, reserve.config, ctx.accounts.attestor.key())?
    });
    Ok(())
}
