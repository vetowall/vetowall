use anchor_lang::prelude::*;

use crate::{
    constants::AUTHORITY_SEED,
    state::{validate_delays, Config},
};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    proposer: Pubkey,
    approver: Option<Pubkey>,
    guardian: Pubkey,
    delays: [i64; 4],
) -> Result<()> {
    validate_delays(&delays)?;
    let (_, authority_bump) = Pubkey::find_program_address(
        &[AUTHORITY_SEED, ctx.accounts.config.key().as_ref()],
        &crate::ID,
    );
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.proposer = proposer;
    config.approver = approver;
    config.guardian = guardian;
    config.delays = delays;
    config.authority_bump = authority_bump;
    Ok(())
}
