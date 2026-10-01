use anchor_lang::prelude::*;

use crate::{
    constants::PROPOSAL_SEED,
    error::ErrorCode,
    firewall::{forbid_durable_nonce, resolve_class, validate_instruction},
    state::{Config, Proposal, ProposalStatus, StoredMeta},
};

#[derive(Accounts)]
pub struct Queue<'info> {
    #[account(mut)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(
        init,
        payer = proposer,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, config.key().as_ref(), &config.proposal_count.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: must be the policy PDA for (config, target, discriminator); it
    /// may not exist yet, which means `Max`. Checked in `resolve_class`.
    pub policy: UncheckedAccount<'info>,
    /// CHECK: address constraint.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_queue(
    ctx: Context<Queue>,
    target_program: Pubkey,
    accounts: Vec<StoredMeta>,
    data: Vec<u8>,
) -> Result<()> {
    let config_key = ctx.accounts.config.key();
    let config = &ctx.accounts.config;
    require!(config.sealed, ErrorCode::NotSealed);
    require_keys_eq!(
        ctx.accounts.proposer.key(),
        config.proposer,
        ErrorCode::NotProposer
    );
    forbid_durable_nonce(&ctx.accounts.instructions)?;
    validate_instruction(config, &config_key, &accounts, &data)?;
    let class = resolve_class(
        &config_key,
        &target_program,
        &data,
        &ctx.accounts.policy,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let id = config.proposal_count;
    let eta = now
        .checked_add(config.delay(class))
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let proposal = &mut ctx.accounts.proposal;
    proposal.config = config_key;
    proposal.id = id;
    proposal.target_program = target_program;
    proposal.accounts = accounts;
    proposal.data = data;
    proposal.class = class;
    proposal.queued_at = now;
    proposal.eta = eta;
    proposal.status = ProposalStatus::Queued;

    ctx.accounts.config.proposal_count = id + 1;
    msg!("queued proposal {} class {:?} eta {}", id, class, eta);
    Ok(())
}
