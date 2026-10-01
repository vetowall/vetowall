use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Privileged instructions can't run in a durable-nonce transaction")]
    NonceTxForbidden,
    #[msg("Signer is not the configured proposer")]
    NotProposer,
    #[msg("Signer is not the configured guardian")]
    NotGuardian,
    #[msg("Signer can't change Vetowall's config")]
    NotGovernor,
    #[msg("Config must be sealed before proposals can be queued")]
    NotSealed,
    #[msg("Config is already sealed")]
    AlreadySealed,
    #[msg("Proposal's timelock hasn't expired")]
    TooEarly,
    #[msg("Proposal is not queued")]
    NotQueued,
    #[msg("Instruction has too many accounts")]
    TooManyAccounts,
    #[msg("Instruction data is too large")]
    DataTooLarge,
    #[msg("Only Vetowall's authority PDA may sign a stored instruction")]
    ForeignSigner,
    #[msg("Policy account doesn't match the target instruction")]
    BadPolicyAccount,
    #[msg("Vetowall's own instructions can't be given a policy")]
    SelfPolicy,
    #[msg("The guardian can't veto changes to Vetowall's own config")]
    GuardianCannotVetoGovernance,
    #[msg("The guardian may only run instructions registered as Safe")]
    NotSafeClass,
    #[msg("Delays must be non-negative and non-decreasing by class")]
    BadDelays,
    #[msg("Signer is not the configured approver")]
    NotApprover,
    #[msg("Instruction isn't Safe and its policy has no limit; queue it instead")]
    NotFastLane,
    #[msg("Amount exceeds what is left of the policy's cap for this window")]
    OverCap,
    #[msg("Supply plus amount would exceed the attested reserves")]
    OverReserves,
    #[msg("Reserve attestation is older than its max age")]
    StaleReserve,
    #[msg("Instruction data is too short to hold the amount")]
    BadAmount,
    #[msg("Discriminator doesn't fit the target's disc_len")]
    BadDiscriminator,
    #[msg("Target already has the maximum number of wide tags")]
    WideTagsFull,
    #[msg("Reserve or mint account doesn't match the policy's limit")]
    BadReserveAccount,
    #[msg("Signer is not the reserve's attestor")]
    NotAttestor,
}
