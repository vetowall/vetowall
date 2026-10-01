pub mod constants;
pub mod error;
pub mod firewall;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("G8LSBa3y5XqY5fK4R6NTK84oPru3W3hsNzRwjunLWedr");

#[program]
pub mod vetowall {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        proposer: Pubkey,
        guardian: Pubkey,
        delays: [i64; 4],
    ) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx, proposer, guardian, delays)
    }

    pub fn register(
        ctx: Context<Register>,
        target_program: Pubkey,
        discriminator: [u8; 8],
        class: ActionClass,
    ) -> Result<()> {
        crate::instructions::governance::handle_register(ctx, target_program, discriminator, class)
    }

    pub fn seal(ctx: Context<Seal>) -> Result<()> {
        crate::instructions::governance::handle_seal(ctx)
    }

    pub fn set_proposer(ctx: Context<Govern>, proposer: Pubkey) -> Result<()> {
        crate::instructions::governance::handle_set_proposer(ctx, proposer)
    }

    pub fn set_guardian(ctx: Context<Govern>, guardian: Pubkey) -> Result<()> {
        crate::instructions::governance::handle_set_guardian(ctx, guardian)
    }

    pub fn set_delays(ctx: Context<Govern>, delays: [i64; 4]) -> Result<()> {
        crate::instructions::governance::handle_set_delays(ctx, delays)
    }

    pub fn queue(
        ctx: Context<Queue>,
        target_program: Pubkey,
        accounts: Vec<StoredMeta>,
        data: Vec<u8>,
    ) -> Result<()> {
        crate::instructions::queue::handle_queue(ctx, target_program, accounts, data)
    }

    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        crate::instructions::execute::handle_execute(ctx)
    }

    pub fn veto(ctx: Context<Veto>, reason: [u8; 32]) -> Result<()> {
        crate::instructions::guardian::handle_veto(ctx, reason)
    }

    pub fn guardian_execute(
        ctx: Context<GuardianExecute>,
        target_program: Pubkey,
        accounts: Vec<StoredMeta>,
        data: Vec<u8>,
    ) -> Result<()> {
        crate::instructions::guardian::handle_guardian_execute(ctx, target_program, accounts, data)
    }
}
