//! One event for every privileged action, so the change-control record lives
//! in the transaction logs and doesn't depend on any offchain bookkeeping.

use anchor_lang::prelude::*;

use crate::state::ActionClass;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RecordKind {
    Queued,
    Executed,
    ExecutedNow,
    Vetoed,
    GuardianExecuted,
    ReserveInitialized,
    ReserveAttested,
    AttestorSet,
    Registered,
    Sealed,
    ProposerSet,
    ApproverSet,
    GuardianSet,
    DelaysSet,
    /// Appended last so older records keep their numbers.
    Initialized,
}

/// Fields that don't apply to a kind are `None`, zero or the default key
/// (see docs/SPEC.md, Events).
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct ChangeRecord {
    pub kind: RecordKind,
    pub config: Pubkey,
    pub proposal_id: Option<u64>,
    pub target_program: Pubkey,
    /// Policy key of the routed instruction, zero-padded to 8 bytes.
    pub discriminator: [u8; 8],
    /// Limited policies' amount; the attested amount; a registered cap.
    pub amount: Option<u64>,
    pub class: Option<ActionClass>,
    /// The signer that acted: proposer, guardian, attestor or governor. The
    /// default key for `execute`, which anyone may call.
    pub actor: Pubkey,
    /// Co-signing approver of `queue` / `execute_now`.
    pub approver: Option<Pubkey>,
    /// The key or mint a governance or reserve change is about.
    pub subject: Option<Pubkey>,
    /// SHA-256 of the guardian's explanation, for `Vetoed`.
    pub reason: [u8; 32],
    pub timestamp: i64,
}

impl ChangeRecord {
    pub fn new(kind: RecordKind, config: Pubkey, actor: Pubkey) -> Result<Self> {
        Ok(Self {
            kind,
            config,
            proposal_id: None,
            target_program: Pubkey::default(),
            discriminator: [0; 8],
            amount: None,
            class: None,
            actor,
            approver: None,
            subject: None,
            reason: [0; 32],
            timestamp: Clock::get()?.unix_timestamp,
        })
    }
}
