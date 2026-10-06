use anchor_lang::prelude::*;

use crate::{
    constants::{AUTHORITY_SEED, MAX_ACCOUNTS, MAX_DATA, MAX_WIDE_TAGS},
    error::ErrorCode,
    firewall::forbid_presigned_setup,
};

/// How dangerous an admin instruction is. Each class has its own timelock.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ActionClass {
    /// Runs immediately, and the guardian may run it directly (e.g. `pause`).
    Safe,
    /// Risk parameters: listings, limits, weights.
    Params,
    /// Authority transfers and upgrades.
    Authority,
    /// Anything unregistered, plus every change to Vetowall's own config.
    Max,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Sets up policies until `seal`; has no power afterwards.
    pub admin: Pubkey,
    /// The only key that may queue proposals, normally a Squads vault PDA.
    pub proposer: Pubkey,
    /// When set, must co-sign every `queue` and `execute_now` (maker-checker).
    pub approver: Option<Pubkey>,
    /// May veto proposals and run `Safe` instructions. Nothing else.
    pub guardian: Pubkey,
    /// Timelock in seconds, indexed by `ActionClass`.
    pub delays: [i64; 4],
    pub sealed: bool,
    pub proposal_count: u64,
    pub authority_bump: u8,
}

impl Config {
    pub fn delay(&self, class: ActionClass) -> i64 {
        self.delays[class as usize]
    }

    pub fn authority(&self, config: &Pubkey) -> Result<Pubkey> {
        Pubkey::create_program_address(
            &[AUTHORITY_SEED, config.as_ref(), &[self.authority_bump]],
            &crate::ID,
        )
        .map_err(|_| error!(ErrorCode::NotGovernor))
    }

    /// Before sealing, the admin governs. After, only the authority PDA does,
    /// which means only a proposal that waited out the `Max` delay.
    ///
    /// `remaining` is the instruction's remaining accounts. Before sealing
    /// the first of them must be the Instructions sysvar, so a pre-signed
    /// setup instruction is refused (see `forbid_presigned_setup`).
    pub fn require_governor(&self, config: &Pubkey, signer: &Pubkey, remaining: &[AccountInfo]) -> Result<()> {
        let governor = if self.sealed {
            self.authority(config)?
        } else {
            forbid_presigned_setup(remaining)?;
            self.admin
        };
        require_keys_eq!(*signer, governor, ErrorCode::NotGovernor);
        Ok(())
    }

    /// Refuses a config in which one key holds two of proposer, approver and
    /// guardian.
    ///
    /// The whole point of the three roles is that no single key is enough. If
    /// the approver is the proposer, maker-checker is one signature. If the
    /// guardian is the proposer or the approver, the only party able to veto
    /// a proposal is one of the parties that made it. The console would still
    /// show three roles, so nobody would notice. We check on every path that
    /// writes a role (`initialize`, `set_proposer`, `set_approver`,
    /// `set_guardian`), after the write, so the invariant holds for every
    /// config created from this build on.
    ///
    /// What this doesn't prove: that the keys belong to different people or
    /// devices. Two addresses can share one seed phrase, and nothing onchain
    /// can see that. A missing approver (`None`) is still allowed; it is the
    /// documented single-signer mode, not a collision.
    pub fn require_distinct_roles(&self) -> Result<()> {
        require!(self.approver != Some(self.proposer), ErrorCode::SameRole);
        require!(self.approver != Some(self.guardian), ErrorCode::SameRole);
        require_keys_neq!(self.guardian, self.proposer, ErrorCode::SameRole);
        Ok(())
    }

    /// Refuses an attestor that is also the proposer or the approver.
    ///
    /// The attestor sets the reserve figure that every mint is checked
    /// against. A signer who can also attest raises the bound and then mints
    /// up to it, so the reserve check would only ever compare a key with
    /// itself. The guardian may be the attestor: it can't mint, so holding
    /// both gains it nothing.
    ///
    /// This is checked when an attestor is set (`init_reserve`,
    /// `set_attestor`). It is not re-checked when the proposer or approver
    /// later changes, because a `Config` doesn't list its reserves. Such a
    /// change is a sealed-config proposal that waits out the `Max` delay in
    /// public, so the guardian's rules are where it gets caught.
    pub fn require_independent_attestor(&self, attestor: &Pubkey) -> Result<()> {
        require_keys_neq!(*attestor, self.proposer, ErrorCode::SameRole);
        require!(self.approver != Some(*attestor), ErrorCode::SameRole);
        Ok(())
    }

    /// Maker-checker: with an approver configured, the proposer alone can't
    /// start anything.
    pub fn require_approver(&self, approver: Option<&Signer>) -> Result<()> {
        if let Some(expected) = self.approver {
            require!(
                approver.is_some_and(|a| a.key() == expected),
                ErrorCode::NotApprover
            );
        }
        Ok(())
    }
}

pub fn validate_delays(delays: &[i64; 4]) -> Result<()> {
    require!(delays[0] >= 0, ErrorCode::BadDelays);
    require!(delays.windows(2).all(|w| w[0] <= w[1]), ErrorCode::BadDelays);
    Ok(())
}

/// How a target program's instructions are told apart. One per target.
#[account]
#[derive(InitSpace)]
pub struct Target {
    pub config: Pubkey,
    pub program: Pubkey,
    /// Discriminator length: 1 for SPL Token / Token-2022, 8 for Anchor.
    pub disc_len: u8,
    /// First bytes whose discriminator is 2 bytes long (Token-2022 extension
    /// instructions such as Pausable). Only used when `disc_len == 1`.
    #[max_len(MAX_WIDE_TAGS)]
    pub wide_tags: Vec<u8>,
}

/// Maps one instruction of a target program to an action class.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub config: Pubkey,
    pub target_program: Pubkey,
    pub discriminator: [u8; 8],
    pub class: ActionClass,
    pub limit: Option<Limit>,
    /// Amount spent through `execute_now` in the current window.
    pub used: u64,
    pub window_start: i64,
}

/// An amount the proposer and approver may move without a timelock, and
/// optionally a reserve bound that applies on every path.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub struct Limit {
    /// Byte offset of the little-endian u64 amount in the instruction data.
    pub amount_offset: u8,
    /// Most that `execute_now` may move per window.
    pub cap: u64,
    /// Window length in seconds.
    pub window: i64,
    /// If set, supply + amount must stay within this `Reserve`'s attestation.
    pub reserve: Option<Pubkey>,
    /// Index, in the stored instruction's accounts, of the mint whose supply
    /// is checked.
    pub mint_index: u8,
}

/// An offchain attestation of the reserves backing a mint.
#[account]
#[derive(InitSpace)]
pub struct Reserve {
    pub config: Pubkey,
    pub mint: Pubkey,
    pub attestor: Pubkey,
    pub amount: u64,
    pub updated_at: i64,
    /// Seconds after `updated_at` that the attestation stays usable.
    pub max_age: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub struct StoredMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ProposalStatus {
    Queued,
    Executed,
    Vetoed,
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub config: Pubkey,
    pub id: u64,
    pub target_program: Pubkey,
    #[max_len(MAX_ACCOUNTS)]
    pub accounts: Vec<StoredMeta>,
    #[max_len(MAX_DATA)]
    pub data: Vec<u8>,
    pub class: ActionClass,
    pub queued_at: i64,
    pub eta: i64,
    pub status: ProposalStatus,
    /// SHA-256 of the guardian's written explanation, kept in its audit log.
    pub veto_reason: [u8; 32],
    /// The amount moved, for instructions whose policy has a limit.
    pub amount: Option<u64>,
    /// When `execute` ran it; 0 until then.
    pub executed_at: i64,
    /// Policy key the instruction was classified by (see `ChangeRecord`).
    pub discriminator: [u8; 8],
}
