use anchor_lang::prelude::*;

use crate::{
    error::ErrorCode,
    firewall::{check_reserve, forbid_durable_nonce, invoke_as_authority, read_amount, resolve_policy},
    state::{Config, Proposal, ProposalStatus, Reserve},
};

/// Anyone may execute a proposal once its timelock has passed. The accounts
/// the stored instruction names, and its target program, go in remaining
/// accounts.
#[derive(Accounts)]
pub struct Execute<'info> {
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config)]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: checked in `resolve_policy`.
    pub target: UncheckedAccount<'info>,
    /// CHECK: checked in `resolve_policy`.
    pub policy: UncheckedAccount<'info>,
    /// Required when the policy's limit names a reserve.
    pub reserve: Option<Account<'info, Reserve>>,
    /// CHECK: address constraint.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_execute(ctx: Context<Execute>) -> Result<()> {
    let config_key = ctx.accounts.config.key();
    let proposal = &mut ctx.accounts.proposal;
    require!(
        proposal.status == ProposalStatus::Queued,
        ErrorCode::NotQueued
    );
    require!(
        Clock::get()?.unix_timestamp >= proposal.eta,
        ErrorCode::TooEarly
    );
    forbid_durable_nonce(&ctx.accounts.instructions)?;

    // The timelock is about intent; the reserve bound is about the supply
    // right now, which may have moved while the proposal waited.
    let policy = resolve_policy(
        &config_key,
        &proposal.target_program,
        &proposal.data,
        &ctx.accounts.target,
        &ctx.accounts.policy,
    )?;
    if let Some(limit) = policy.and_then(|p| p.limit) {
        let amount = read_amount(&proposal.data, limit.amount_offset)?;
        check_reserve(
            &limit,
            amount,
            &proposal.accounts,
            ctx.remaining_accounts,
            ctx.accounts.reserve.as_ref(),
        )?;
    }

    proposal.status = ProposalStatus::Executed;
    msg!("executing proposal {}", proposal.id);
    invoke_as_authority(
        &ctx.accounts.config,
        &config_key,
        proposal.target_program,
        &proposal.accounts,
        proposal.data.clone(),
        ctx.remaining_accounts,
    )
}
