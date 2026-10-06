//! The guardian's two powers. It can stop things; it can't make anything
//! happen except instructions the protocol registered as `Safe`.

use anchor_lang::prelude::*;

use crate::{
    error::ErrorCode,
    event::{ChangeRecord, RecordKind},
    firewall::{forbid_durable_nonce, invoke_as_authority, resolve_policy, validate_instruction},
    state::{ActionClass, Config, Proposal, ProposalStatus, StoredMeta},
};

#[derive(Accounts)]
pub struct Veto<'info> {
    pub config: Account<'info, Config>,
    pub guardian: Signer<'info>,
    #[account(mut, has_one = config)]
    pub proposal: Account<'info, Proposal>,
}

/// A veto is final. The multisig has to queue the action again, which starts
/// the timelock over.
pub fn handle_veto(ctx: Context<Veto>, reason: [u8; 32]) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.guardian.key(),
        ctx.accounts.config.guardian,
        ErrorCode::NotGuardian
    );
    let proposal = &mut ctx.accounts.proposal;
    require!(
        proposal.status == ProposalStatus::Queued,
        ErrorCode::NotQueued
    );
    // Otherwise a compromised guardian could block its own rotation forever.
    // Only the rotation is exempt. Every other change to Vetowall's config
    // can be vetoed: a compromised proposer and approver would otherwise
    // queue `register(MintTo, Safe, no limit)` and wait out the delay with
    // nobody able to stop it.
    let rotates_guardian = proposal.target_program == crate::ID
        && proposal.discriminator == crate::instruction::SetGuardian::DISCRIMINATOR;
    require!(!rotates_guardian, ErrorCode::GuardianCannotVetoGovernance);
    proposal.status = ProposalStatus::Vetoed;
    proposal.veto_reason = reason;
    msg!("vetoed proposal {}", proposal.id);
    emit!(ChangeRecord {
        proposal_id: Some(proposal.id),
        target_program: proposal.target_program,
        discriminator: proposal.discriminator,
        amount: proposal.amount,
        class: Some(proposal.class),
        reason,
        ..ChangeRecord::new(RecordKind::Vetoed, proposal.config, ctx.accounts.guardian.key())?
    });
    Ok(())
}

#[derive(Accounts)]
pub struct GuardianExecute<'info> {
    pub config: Account<'info, Config>,
    pub guardian: Signer<'info>,
    /// CHECK: checked in `resolve_policy`.
    pub target: UncheckedAccount<'info>,
    /// CHECK: checked in `resolve_policy`.
    pub policy: UncheckedAccount<'info>,
    /// CHECK: address constraint.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Runs a `Safe` instruction (e.g. `pause`) immediately, with no timelock.
/// Policies with a limit are refused: the guardian never moves amounts.
pub fn handle_guardian_execute(
    ctx: Context<GuardianExecute>,
    target_program: Pubkey,
    accounts: Vec<StoredMeta>,
    data: Vec<u8>,
) -> Result<()> {
    let config_key = ctx.accounts.config.key();
    let config = &ctx.accounts.config;
    require_keys_eq!(
        ctx.accounts.guardian.key(),
        config.guardian,
        ErrorCode::NotGuardian
    );
    forbid_durable_nonce(&ctx.accounts.instructions)?;
    validate_instruction(config, &config_key, &accounts, &data)?;
    let (discriminator, policy) = resolve_policy(
        &config_key,
        &target_program,
        &data,
        &ctx.accounts.target,
        &ctx.accounts.policy,
    )?;
    require!(
        policy.is_some_and(|p| p.class == ActionClass::Safe && p.limit.is_none()),
        ErrorCode::NotSafeClass
    );
    emit!(ChangeRecord {
        target_program,
        discriminator,
        class: Some(ActionClass::Safe),
        ..ChangeRecord::new(RecordKind::GuardianExecuted, config_key, ctx.accounts.guardian.key())?
    });
    invoke_as_authority(
        config,
        &config_key,
        target_program,
        &accounts,
        data,
        ctx.remaining_accounts,
    )
}
