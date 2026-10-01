pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("46BaaWFuFK3T8akXjL2xFzcv6M5AWAKXFcuxdU3jfc3a");

#[program]
pub mod mock_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, withdraw_limit: u64) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx, withdraw_limit)
    }

    pub fn set_admin(ctx: Context<Admin>, new_admin: Pubkey) -> Result<()> {
        crate::instructions::admin::handle_set_admin(ctx, new_admin)
    }

    pub fn list_collateral(
        ctx: Context<Admin>,
        mint: Pubkey,
        price: u64,
        weight_bps: u16,
    ) -> Result<()> {
        crate::instructions::admin::handle_list_collateral(ctx, mint, price, weight_bps)
    }

    pub fn set_withdraw_limit(ctx: Context<Admin>, withdraw_limit: u64) -> Result<()> {
        crate::instructions::admin::handle_set_withdraw_limit(ctx, withdraw_limit)
    }

    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        crate::instructions::admin::handle_pause(ctx)
    }

    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        crate::instructions::admin::handle_unpause(ctx)
    }

    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        crate::instructions::deposit::handle_deposit_collateral(ctx, amount)
    }

    pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
        crate::instructions::borrow::handle_borrow(ctx, amount)
    }
}
