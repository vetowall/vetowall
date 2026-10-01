export const explorer = (kind: 'address' | 'tx', id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
