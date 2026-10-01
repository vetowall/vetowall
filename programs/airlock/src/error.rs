use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Privileged instructions can't run in a durable-nonce transaction")]
    NonceTxForbidden,
    #[msg("Signer is not the configured proposer")]
    NotProposer,
    #[msg("Signer is not the configured guardian")]
    NotGuardian,
    #[msg("Signer can't change Airlock's config")]
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
    #[msg("Only Airlock's authority PDA may sign a stored instruction")]
    ForeignSigner,
    #[msg("Policy account doesn't match the target instruction")]
    BadPolicyAccount,
    #[msg("Airlock's own instructions can't be given a policy")]
    SelfPolicy,
    #[msg("The guardian can't veto changes to Airlock's own config")]
    GuardianCannotVetoGovernance,
    #[msg("The guardian may only run instructions registered as Safe")]
    NotSafeClass,
    #[msg("Delays must be non-negative and non-decreasing by class")]
    BadDelays,
}
