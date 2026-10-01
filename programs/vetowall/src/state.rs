use anchor_lang::prelude::*;

use crate::{
    constants::{AUTHORITY_SEED, MAX_ACCOUNTS, MAX_DATA},
    error::ErrorCode,
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
    pub fn require_governor(&self, config: &Pubkey, signer: &Pubkey) -> Result<()> {
        let governor = if self.sealed {
            self.authority(config)?
        } else {
            self.admin
        };
        require_keys_eq!(*signer, governor, ErrorCode::NotGovernor);
        Ok(())
    }
}

pub fn validate_delays(delays: &[i64; 4]) -> Result<()> {
    require!(delays[0] >= 0, ErrorCode::BadDelays);
    require!(delays.windows(2).all(|w| w[0] <= w[1]), ErrorCode::BadDelays);
    Ok(())
}

/// Maps one instruction of a target program to an action class.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub config: Pubkey,
    pub target_program: Pubkey,
    pub discriminator: [u8; 8],
    pub class: ActionClass,
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
}
