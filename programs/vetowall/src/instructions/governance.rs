//! Changes to Vetowall's own config. Before `seal` the admin makes them
//! directly, to set the firewall up. After `seal` they only run through
//! `queue` + `execute`, which always puts them in the `Max` class.

use anchor_lang::prelude::*;

use crate::{
    constants::{MAX_WIDE_TAGS, POLICY_SEED, TARGET_SEED},
    error::ErrorCode,
    state::{validate_delays, ActionClass, Config, Limit, Policy, Target},
};

#[derive(Accounts)]
pub struct Govern<'info> {
    #[account(mut)]
    pub config: Account<'info, Config>,
    pub governor: Signer<'info>,
}

pub fn handle_set_proposer(ctx: Context<Govern>, proposer: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.require_governor(&config.key(), &ctx.accounts.governor.key())?;
    config.proposer = proposer;
    Ok(())
}

pub fn handle_set_approver(ctx: Context<Govern>, approver: Option<Pubkey>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.require_governor(&config.key(), &ctx.accounts.governor.key())?;
    config.approver = approver;
    Ok(())
}

pub fn handle_set_guardian(ctx: Context<Govern>, guardian: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.require_governor(&config.key(), &ctx.accounts.governor.key())?;
    config.guardian = guardian;
    Ok(())
}

pub fn handle_set_delays(ctx: Context<Govern>, delays: [i64; 4]) -> Result<()> {
    validate_delays(&delays)?;
    let config = &mut ctx.accounts.config;
    config.require_governor(&config.key(), &ctx.accounts.governor.key())?;
    config.delays = delays;
    Ok(())
}

#[derive(Accounts)]
pub struct Seal<'info> {
    #[account(mut, has_one = admin @ ErrorCode::NotGovernor)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

pub fn handle_seal(ctx: Context<Seal>) -> Result<()> {
    require!(!ctx.accounts.config.sealed, ErrorCode::AlreadySealed);
    ctx.accounts.config.sealed = true;
    Ok(())
}

#[derive(Accounts)]
#[instruction(target_program: Pubkey, discriminator: [u8; 8])]
pub struct Register<'info> {
    pub config: Account<'info, Config>,
    /// Pays for the target and policy accounts. After `seal` this is the
    /// authority PDA, so it needs a little SOL.
    #[account(mut)]
    pub governor: Signer<'info>,
    #[account(
        init_if_needed,
        payer = governor,
        space = 8 + Target::INIT_SPACE,
        seeds = [TARGET_SEED, config.key().as_ref(), target_program.as_ref()],
        bump
    )]
    pub target: Account<'info, Target>,
    #[account(
        init_if_needed,
        payer = governor,
        space = 8 + Policy::INIT_SPACE,
        seeds = [
            POLICY_SEED,
            config.key().as_ref(),
            target_program.as_ref(),
            discriminator.as_ref()
        ],
        bump
    )]
    pub policy: Account<'info, Policy>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register(
    ctx: Context<Register>,
    target_program: Pubkey,
    discriminator: [u8; 8],
    disc_len: u8,
    class: ActionClass,
    limit: Option<Limit>,
) -> Result<()> {
    require_keys_neq!(target_program, crate::ID, ErrorCode::SelfPolicy);
    let config = &ctx.accounts.config;
    config.require_governor(&config.key(), &ctx.accounts.governor.key())?;
    require!((1..=8).contains(&disc_len), ErrorCode::BadDiscriminator);

    let target = &mut ctx.accounts.target;
    if target.config == Pubkey::default() {
        target.config = config.key();
        target.program = target_program;
        target.disc_len = disc_len;
    }
    // Changing disc_len would silently move every existing policy's address.
    require!(target.disc_len == disc_len, ErrorCode::BadDiscriminator);

    // On a 1-byte target, a non-zero second byte makes this a 2-byte
    // discriminator, and from then on its first byte is looked up wide.
    let wide = disc_len == 1 && discriminator[1] != 0;
    let len = if wide { 2 } else { usize::from(disc_len) };
    require!(
        discriminator[len..].iter().all(|b| *b == 0),
        ErrorCode::BadDiscriminator
    );
    if wide && !target.wide_tags.contains(&discriminator[0]) {
        require!(
            target.wide_tags.len() < MAX_WIDE_TAGS,
            ErrorCode::WideTagsFull
        );
        target.wide_tags.push(discriminator[0]);
    }

    // Re-registering keeps `used` and `window_start`, so changing a cap
    // doesn't hand out a fresh window.
    let policy = &mut ctx.accounts.policy;
    policy.config = config.key();
    policy.target_program = target_program;
    policy.discriminator = discriminator;
    policy.class = class;
    policy.limit = limit;
    Ok(())
}
