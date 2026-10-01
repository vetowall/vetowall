//! The fast lane: routine issuer operations (mints within a daily cap,
//! `Safe` instructions) run immediately with proposer + approver signatures.

use anchor_lang::prelude::*;

use crate::{
    error::ErrorCode,
    event::{ChangeRecord, RecordKind},
    firewall::{
        charge_cap, check_reserve, forbid_durable_nonce, invoke_as_authority, read_amount,
        resolve_policy, validate_instruction,
    },
    state::{ActionClass, Config, Reserve, StoredMeta},
};

#[derive(Accounts)]
pub struct ExecuteNow<'info> {
    pub config: Account<'info, Config>,
    pub proposer: Signer<'info>,
    /// Required when the config names an approver.
    pub approver: Option<Signer<'info>>,
    /// CHECK: checked in `resolve_policy`.
    pub target: UncheckedAccount<'info>,
    /// CHECK: checked in `resolve_policy`; written back when the cap is charged.
    #[account(mut)]
    pub policy: UncheckedAccount<'info>,
    /// Required when the policy's limit names a reserve.
    pub reserve: Option<Account<'info, Reserve>>,
    /// CHECK: address constraint.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_execute_now(
    ctx: Context<ExecuteNow>,
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

    // Unregistered instructions and Vetowall's own config are `Max`, which
    // never has a fast lane.
    let (discriminator, policy) = resolve_policy(
        &config_key,
        &target_program,
        &data,
        &ctx.accounts.target,
        &ctx.accounts.policy,
    )?;
    let mut policy = policy.ok_or(ErrorCode::NotFastLane)?;
    let mut amount = None;

    match policy.limit {
        Some(limit) => {
            let amt = read_amount(&data, limit.amount_offset)?;
            amount = Some(amt);
            if policy.class != ActionClass::Safe {
                charge_cap(&mut policy, &limit, amt, Clock::get()?.unix_timestamp)?;
                policy.try_serialize(&mut &mut ctx.accounts.policy.try_borrow_mut_data()?[..])?;
            }
            check_reserve(
                &limit,
                amt,
                &accounts,
                ctx.remaining_accounts,
                ctx.accounts.reserve.as_ref(),
            )?;
        }
        None => require!(policy.class == ActionClass::Safe, ErrorCode::NotFastLane),
    }

    msg!("fast lane {:?}", policy.class);
    emit!(ChangeRecord {
        target_program,
        discriminator,
        amount,
        class: Some(policy.class),
        approver: ctx.accounts.approver.as_ref().map(|a| a.key()),
        ..ChangeRecord::new(RecordKind::ExecutedNow, config_key, ctx.accounts.proposer.key())?
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
