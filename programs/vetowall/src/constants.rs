use anchor_lang::prelude::*;

#[constant]
pub const AUTHORITY_SEED: &[u8] = b"authority";

#[constant]
pub const POLICY_SEED: &[u8] = b"policy";

#[constant]
pub const PROPOSAL_SEED: &[u8] = b"proposal";

#[constant]
pub const TARGET_SEED: &[u8] = b"target";

#[constant]
pub const RESERVE_SEED: &[u8] = b"reserve";

/// First bytes of a `disc_len = 1` target whose instructions use a 2-byte
/// discriminator (Token-2022 extensions). Targets are allocated at this size.
pub const MAX_WIDE_TAGS: usize = 16;

/// Mint supply is a little-endian u64 at this offset in the base mint layout,
/// which SPL Token and Token-2022 share.
pub const MINT_SUPPLY_OFFSET: u8 = 36;

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Upper bounds on a stored instruction. Proposal accounts are allocated at
/// the maximum size, so these also fix the rent a proposal costs.
pub const MAX_ACCOUNTS: usize = 16;
pub const MAX_DATA: usize = 1024;

/// How long after its `eta` a proposal can still be executed. Without this a
/// forgotten proposal stays live forever, and anyone can execute it months
/// later, when nobody remembers approving it. Two weeks matches the grace
/// period Compound's timelock uses.
pub const GRACE: i64 = 14 * 24 * 60 * 60;

/// `SystemInstruction::AdvanceNonceAccount`, as the little-endian u32 the
/// system program uses for its instruction tag.
pub const ADVANCE_NONCE_TAG: [u8; 4] = 4u32.to_le_bytes();
