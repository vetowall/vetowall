use anchor_lang::prelude::*;

#[constant]
pub const AUTHORITY_SEED: &[u8] = b"authority";

#[constant]
pub const POLICY_SEED: &[u8] = b"policy";

#[constant]
pub const PROPOSAL_SEED: &[u8] = b"proposal";

/// Upper bounds on a stored instruction. Proposal accounts are allocated at
/// the maximum size, so these also fix the rent a proposal costs.
pub const MAX_ACCOUNTS: usize = 16;
pub const MAX_DATA: usize = 1024;

/// `SystemInstruction::AdvanceNonceAccount`, as the little-endian u32 the
/// system program uses for its instruction tag.
pub const ADVANCE_NONCE_TAG: [u8; 4] = 4u32.to_le_bytes();
