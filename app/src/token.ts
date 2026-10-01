// Token-2022 side: the launch transaction and reading a mint's authorities.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import {
  AuthorityType,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  LENGTH_SIZE,
  TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createFreezeAccountInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createMintToInstruction,
  createPauseInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMetadataPointerState,
  getMint,
  getMintCloseAuthority,
  getMintLen,
  getPausableConfig,
  getPermanentDelegate,
  getTokenMetadata,
} from '@solana/spl-token';
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata';

export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID;

export interface LaunchParams {
  name: string;
  symbol: string;
  uri: string;
  decimals: number;
}

/**
 * One transaction that creates the mint and leaves every authority with the
 * Vetowall PDA. Token metadata can only be initialized with the mint
 * authority's signature, so the payer holds the mint authority for the
 * length of this transaction and hands it over in the last instruction. If
 * any step fails, nothing lands, so a god key never exists onchain.
 */
export async function launchTx(
  connection: Connection,
  payer: PublicKey,
  mint: Keypair,
  authority: PublicKey,
  p: LaunchParams,
): Promise<Transaction> {
  const extensions = [
    ExtensionType.MetadataPointer,
    ExtensionType.PermanentDelegate,
    ExtensionType.PausableConfig,
    ExtensionType.MintCloseAuthority,
  ];
  const space = getMintLen(extensions);
  const metadataLen =
    TYPE_SIZE +
    LENGTH_SIZE +
    pack({ updateAuthority: authority, mint: mint.publicKey, name: p.name, symbol: p.symbol, uri: p.uri, additionalMetadata: [] }).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(space + metadataLen);
  const m = mint.publicKey;
  const P = TOKEN_2022;
  return new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: m, space, lamports, programId: P }),
    createInitializeMetadataPointerInstruction(m, authority, m, P),
    createInitializePermanentDelegateInstruction(m, authority, P),
    createInitializePausableConfigInstruction(m, authority, P),
    createInitializeMintCloseAuthorityInstruction(m, authority, P),
    createInitializeMint2Instruction(m, p.decimals, payer, authority, P),
    createInitializeInstruction({
      programId: P, metadata: m, updateAuthority: authority, mint: m, mintAuthority: payer,
      name: p.name, symbol: p.symbol, uri: p.uri,
    }),
    createSetAuthorityInstruction(m, payer, AuthorityType.MintTokens, authority, [], P),
    // The issuer's treasury account, so the first mint has somewhere to land.
    createAssociatedTokenAccountIdempotentInstruction(payer, ata(payer, m), payer, m, P),
  );
}

export const ata = (owner: PublicKey, mint: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022);

// Instructions Vetowall stores and runs as the authority PDA.
export const mintToIx = (mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint) =>
  createMintToInstruction(mint, dest, authority, amount, [], TOKEN_2022);
export const freezeIx = (account: PublicKey, mint: PublicKey, authority: PublicKey) =>
  createFreezeAccountInstruction(account, mint, authority, [], TOKEN_2022);
export const pauseIx = (mint: PublicKey, authority: PublicKey): TransactionInstruction =>
  createPauseInstruction(mint, authority, [], TOKEN_2022);

const holder = (k: PublicKey | null | undefined) => (!k || k.equals(PublicKey.default) ? null : k.toBase58());

export async function readMint(connection: Connection, mint: PublicKey) {
  const info = await getMint(connection, mint, 'confirmed', TOKEN_2022);
  const meta = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022).catch(() => null);
  const pausable = getPausableConfig(info);
  return {
    supply: info.supply,
    decimals: info.decimals,
    symbol: meta?.symbol || 'TOKEN',
    paused: pausable?.paused ?? false,
    authorities: [
      { name: 'Mint', holder: holder(info.mintAuthority) },
      { name: 'Freeze', holder: holder(info.freezeAuthority) },
      { name: 'Permanent delegate', holder: holder(getPermanentDelegate(info)?.delegate) },
      { name: 'Pause', holder: holder(pausable?.authority) },
      { name: 'Metadata pointer', holder: holder(getMetadataPointerState(info)?.authority) },
      { name: 'Metadata update', holder: holder(meta?.updateAuthority) },
      { name: 'Close mint', holder: holder(getMintCloseAuthority(info)?.closeAuthority) },
    ],
  };
}
