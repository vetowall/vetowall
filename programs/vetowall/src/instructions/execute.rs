use anchor_lang::prelude::*;

use crate::{
    error::ErrorCode,
    firewall::{forbid_durable_nonce, invoke_as_authority},
    state::{Config, Proposal, ProposalStatus},
};

/// Anyone may execute a proposal once its timelock has passed. The accounts
/// the stored instruction names, and its target program, go in remaining
/// accounts.
#[derive(Accounts)]
pub struct Execute<'info> {
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config)]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: address constraint.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_execute(ctx: Context<Execute>) -> Result<()> {
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

    proposal.status = ProposalStatus::Executed;
    msg!("executing proposal {}", proposal.id);
    invoke_as_authority(
        &ctx.accounts.config,
        &ctx.accounts.config.key(),
        proposal.target_program,
        &proposal.accounts,
        proposal.data.clone(),
        ctx.remaining_accounts,
    )
}
