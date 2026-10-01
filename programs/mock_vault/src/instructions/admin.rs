use anchor_lang::prelude::*;

use crate::{
    constants::BPS,
    error::ErrorCode,
    state::{Market, Vault},
};

/// Every admin instruction takes the same two accounts. For a vault guarded by
/// Vetowall, `admin` is Vetowall's authority PDA, signing through `execute`.
#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, has_one = admin @ ErrorCode::Unauthorized)]
    pub vault: Account<'info, Vault>,
    pub admin: Signer<'info>,
}

pub fn handle_set_admin(ctx: Context<Admin>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.vault.admin = new_admin;
    Ok(())
}

pub fn handle_list_collateral(
    ctx: Context<Admin>,
    mint: Pubkey,
    price: u64,
    weight_bps: u16,
) -> Result<()> {
    require!(u64::from(weight_bps) <= BPS, ErrorCode::BadWeight);
    let markets = &mut ctx.accounts.vault.markets;
    let slot = match markets.iter().position(|m| m.mint == mint) {
        Some(i) => i,
        None => markets
            .iter()
            .position(|m| m.mint == Pubkey::default())
            .ok_or(ErrorCode::MarketsFull)?,
    };
    markets[slot] = Market {
        mint,
        price,
        weight_bps,
    };
    Ok(())
}

pub fn handle_set_withdraw_limit(ctx: Context<Admin>, withdraw_limit: u64) -> Result<()> {
    ctx.accounts.vault.withdraw_limit = withdraw_limit;
    Ok(())
}

// Pause and unpause are separate instructions so a firewall can let a guardian
// pause instantly without also letting it unpause.
pub fn handle_pause(ctx: Context<Admin>) -> Result<()> {
    ctx.accounts.vault.paused = true;
    Ok(())
}

pub fn handle_unpause(ctx: Context<Admin>) -> Result<()> {
    ctx.accounts.vault.paused = false;
    Ok(())
}
