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
        approver: Option<Pubkey>,
        guardian: Pubkey,
        delays: [i64; 4],
    ) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx, proposer, approver, guardian, delays)
    }

    pub fn register(
        ctx: Context<Register>,
        target_program: Pubkey,
        discriminator: [u8; 8],
        disc_len: u8,
        class: ActionClass,
        limit: Option<Limit>,
    ) -> Result<()> {
        crate::instructions::governance::handle_register(
            ctx,
            target_program,
            discriminator,
            disc_len,
            class,
            limit,
        )
    }

    pub fn init_reserve(
        ctx: Context<InitReserve>,
        mint: Pubkey,
        attestor: Pubkey,
        max_age: i64,
    ) -> Result<()> {
        crate::instructions::reserve::handle_init_reserve(ctx, mint, attestor, max_age)
    }

    pub fn attest_reserve(ctx: Context<AttestReserve>, amount: u64) -> Result<()> {
        crate::instructions::reserve::handle_attest_reserve(ctx, amount)
    }

    pub fn set_attestor(ctx: Context<SetAttestor>, attestor: Pubkey) -> Result<()> {
        crate::instructions::reserve::handle_set_attestor(ctx, attestor)
    }

    pub fn seal(ctx: Context<Seal>) -> Result<()> {
        crate::instructions::governance::handle_seal(ctx)
    }

    pub fn set_proposer(ctx: Context<Govern>, proposer: Pubkey) -> Result<()> {
        crate::instructions::governance::handle_set_proposer(ctx, proposer)
    }

    pub fn set_approver(ctx: Context<Govern>, approver: Option<Pubkey>) -> Result<()> {
        crate::instructions::governance::handle_set_approver(ctx, approver)
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

    pub fn execute_now(
        ctx: Context<ExecuteNow>,
        target_program: Pubkey,
        accounts: Vec<StoredMeta>,
        data: Vec<u8>,
    ) -> Result<()> {
        crate::instructions::execute_now::handle_execute_now(ctx, target_program, accounts, data)
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
