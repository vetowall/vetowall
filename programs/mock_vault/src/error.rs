use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Signer is not the vault admin")]
    Unauthorized,
    #[msg("Vault is paused")]
    Paused,
    #[msg("Collateral mint is not listed")]
    NotListed,
    #[msg("No free market slot")]
    MarketsFull,
    #[msg("Collateral weight must be at most 10000 bps")]
    BadWeight,
    #[msg("Borrow exceeds the per-transaction withdraw limit")]
    OverLimit,
    #[msg("Borrow exceeds the position's collateral credit")]
    InsufficientCredit,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
