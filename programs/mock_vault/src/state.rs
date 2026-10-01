use anchor_lang::prelude::*;

use crate::constants::MAX_MARKETS;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub creator: Pubkey,
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    /// Largest single borrow, in USDC base units. Drift's attacker raised this
    /// kind of circuit breaker 20x before draining.
    pub withdraw_limit: u64,
    pub paused: bool,
    pub markets: [Market; MAX_MARKETS],
    pub bump: u8,
}

impl Vault {
    pub fn market(&self, mint: &Pubkey) -> Option<&Market> {
        self.markets
            .iter()
            .find(|m| m.mint == *mint && *mint != Pubkey::default())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Market {
    pub mint: Pubkey,
    /// USDC base units per whole collateral token.
    pub price: u64,
    pub weight_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub vault: Pubkey,
    pub owner: Pubkey,
    /// Borrowing power in USDC base units, priced when the collateral was deposited.
    pub credit: u64,
    pub debt: u64,
}
