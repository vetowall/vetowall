use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::ErrorCode,
    state::{Position, Vault},
};

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub vault: Account<'info, Vault>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        seeds = [COLLATERAL_SEED, vault.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault
    )]
    pub collateral: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    require!(!vault.paused, ErrorCode::Paused);
    let market = *vault
        .market(&ctx.accounts.mint.key())
        .ok_or(ErrorCode::NotListed)?;

    token::transfer(
        CpiContext::new(
            token::ID,
            Transfer {
                from: ctx.accounts.owner_tokens.to_account_info(),
                to: ctx.accounts.collateral.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    // ponytail: credit is priced once, at deposit. A real lending market marks
    // collateral to an oracle on every borrow; the replay only needs the listing price.
    let value = u128::from(amount)
        .checked_mul(u128::from(market.price))
        .and_then(|v| v.checked_mul(u128::from(market.weight_bps)))
        .and_then(|v| v.checked_div(10u128.pow(u32::from(ctx.accounts.mint.decimals))))
        .and_then(|v| v.checked_div(u128::from(BPS)))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(ErrorCode::MathOverflow)?;

    let position = &mut ctx.accounts.position;
    position.vault = vault.key();
    position.owner = ctx.accounts.owner.key();
    position.credit = position
        .credit
        .checked_add(value)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}
