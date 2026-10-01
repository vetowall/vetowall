//! Changes to Airlock's own config. Before `seal` the admin makes them
//! directly, to set the firewall up. After `seal` they only run through
//! `queue` + `execute`, which always puts them in the `Max` class.

use anchor_lang::prelude::*;

use crate::{
    constants::POLICY_SEED,
    error::ErrorCode,
    state::{validate_delays, ActionClass, Config, Policy},
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
    /// Pays for the policy account. After `seal` this is the authority PDA,
    /// so it needs a little SOL.
    #[account(mut)]
    pub governor: Signer<'info>,
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
    class: ActionClass,
) -> Result<()> {
    require_keys_neq!(target_program, crate::ID, ErrorCode::SelfPolicy);
    let config = &ctx.accounts.config;
    config.require_governor(&config.key(), &ctx.accounts.governor.key())?;
    let policy = &mut ctx.accounts.policy;
    policy.config = config.key();
    policy.target_program = target_program;
    policy.discriminator = discriminator;
    policy.class = class;
    Ok(())
}
