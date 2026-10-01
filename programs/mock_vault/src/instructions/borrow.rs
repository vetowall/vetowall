use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::ErrorCode,
    state::{Position, Vault},
};

#[derive(Accounts)]
pub struct Borrow<'info> {
    pub owner: Signer<'info>,
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [RESERVE_SEED, vault.key().as_ref()],
        bump
    )]
    pub reserve: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vault.usdc_mint)]
    pub destination: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump,
        has_one = owner
    )]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    require!(!vault.paused, ErrorCode::Paused);
    require!(amount <= vault.withdraw_limit, ErrorCode::OverLimit);

    let position = &mut ctx.accounts.position;
    let debt = position
        .debt
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(debt <= position.credit, ErrorCode::InsufficientCredit);
    position.debt = debt;

    let creator = vault.creator;
    let seeds: &[&[u8]] = &[VAULT_SEED, creator.as_ref(), &[vault.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token::ID,
            Transfer {
                from: ctx.accounts.reserve.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}
