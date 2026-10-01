// Writes the human-readable reason for a veto the rules already decided.
// Claude (when ANTHROPIC_API_KEY is set) only rewords the rule facts; the veto
// is sent whether or not this succeeds, and any failure falls back to the
// deterministic template.

import Anthropic from "@anthropic-ai/sdk";
import type { Hit } from "./rules.ts";

const SENTENCES: Record<string, (f: Hit["facts"]) => string> = {
  mint_unbacked: (f) =>
    `It mints ${f.amount} tokens, but attested reserves (${f.attested_reserves}) minus current supply (${f.supply}) leave room for only ${f.headroom}, so ${f.unbacked} would be unbacked.`,
  mint_over_ceiling: (f) => `It mints ${f.amount} tokens, above the absolute per-mint ceiling of ${f.ceiling}.`,
  mint_over_average: (f) =>
    `It mints ${f.amount} tokens, more than ${f.multiple}x the 7-day average of ${f.avg_7d} across ${f.mints_7d} executed mints.`,
  set_authority: (f) =>
    `It hands the ${f.authority_type} authority of ${f.target} to ${f.new_authority ?? "nobody (revoking it)"}.`,
  max_class: (f) => `It runs ${f.instruction} on ${f.program}, which is unregistered or registered as Max class.`,
  young_collateral: (f) =>
    f.mint_age_days === null
      ? `It lists ${f.collateral_mint} as collateral, and that mint has no onchain history.`
      : `It lists ${f.collateral_mint} as collateral, a mint only ${f.mint_age_days} days old.`,
  withdraw_limit_jump: (f) =>
    `It raises the vault withdraw limit from ${f.current_limit} to ${f.new_limit}${f.multiple === null ? "" : ` (${f.multiple}x)`}, above the 5x bound.`,
  recent_role_change: (f) =>
    `It was queued ${f.hours_after_change} hours after the ${f.role} changed, inside the 7-day cooling-off window.`,
};

export function template(id: bigint, hits: Hit[]): string {
  const why = hits.map((h) => SENTENCES[h.rule]?.(h.facts) ?? `Rule ${h.rule} matched.`).join(" ");
  return `Guardian vetoed proposal #${id}. ${why} The multisig can re-queue it if this was intended, which restarts the timelock.`;
}

const SYSTEM = `You write the public explanation for a veto that deterministic rules have already decided and sent. You have no say in the decision.
Write 2-3 plain-English sentences for the issuer's signers and token holders: what the proposal would have done and why the rule stopped it.
Use only the facts given; do not speculate about intent or add numbers that are not in the facts. Plain text, no markdown, no preamble.`;

/** Returns the explanation text and who wrote it. Never throws. */
export async function explain(id: bigint, hits: Hit[]): Promise<{ text: string; by: "claude" | "template" }> {
  const fallback = { text: template(id, hits), by: "template" as const };
  if (!process.env.ANTHROPIC_API_KEY) return fallback;
  try {
    // Short timeout: the veto has to land before the proposal's eta.
    const client = new Anthropic({ timeout: 20_000, maxRetries: 1 });
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4096,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify({ proposal_id: id.toString(), rules: hits }) }],
    });
    if (res.stop_reason === "refusal") return fallback;
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return text ? { text, by: "claude" } : fallback;
  } catch (e) {
    console.error("explain: Claude unavailable, using template:", e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
    return fallback;
  }
}
