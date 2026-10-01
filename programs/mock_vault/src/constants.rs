use anchor_lang::prelude::*;

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const RESERVE_SEED: &[u8] = b"reserve";

#[constant]
pub const COLLATERAL_SEED: &[u8] = b"collateral";

#[constant]
pub const POSITION_SEED: &[u8] = b"position";

pub const MAX_MARKETS: usize = 4;

pub const BPS: u64 = 10_000;
