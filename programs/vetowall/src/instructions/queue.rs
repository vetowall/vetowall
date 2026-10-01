use anchor_lang::prelude::*;

use crate::{
    constants::PROPOSAL_SEED,
    error::ErrorCode,
    firewall::{class_of, forbid_durable_nonce, read_amount, resolve_policy, validate_instruction},
    state::{Config, Proposal, ProposalStatus, StoredMeta},
};

#[derive(Accounts)]
pub struct Queue<'info> {
    #[account(mut)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub proposer: Signer<'info>,
    /// Required when the config names an approver.
    pub approver: Option<Signer<'info>>,
    #[account(
        init,
        payer = proposer,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, config.key().as_ref(), &config.proposal_count.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: the target PDA for (config, target program); it may not exist
    /// yet, which means `Max`. Checked in `resolve_policy`.
    pub target: UncheckedAccount<'info>,
    /// CHECK: the policy PDA for the instruction's discriminator; it may not
    /// exist yet, which means `Max`. Checked in `resolve_policy`.
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
    config.require_approver(ctx.accounts.approver.as_ref())?;
    forbid_durable_nonce(&ctx.accounts.instructions)?;
    validate_instruction(config, &config_key, &accounts, &data)?;
    let policy = resolve_policy(
        &config_key,
        &target_program,
        &data,
        &ctx.accounts.target,
        &ctx.accounts.policy,
    )?;
    let class = class_of(&policy);
    // Recorded so the guardian and the console can see how much a queued
    // mint is for without decoding the instruction. The reserve bound is
    // checked at execute, against the supply at that time.
    let amount = policy
        .and_then(|p| p.limit)
        .map(|limit| read_amount(&data, limit.amount_offset))
        .transpose()?;

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
    proposal.amount = amount;

    ctx.accounts.config.proposal_count = id + 1;
    msg!("queued proposal {} class {:?} eta {}", id, class, eta);
    Ok(())
}
