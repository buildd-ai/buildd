/**
 * The optional diagnosis narrative — the ONLY place a model is used.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * It runs after the verdict and after the decision to page. It cannot change
 * either. Its failure mode is "the page has no prose paragraph", never "no
 * page". Every exit from this module that is not a string is `null`, and there
 * is no throw path a caller could forget to catch.
 *
 * ── Why it reuses the platform's credential ─────────────────────────────────
 * `CLAUDE_CODE_OAUTH_TOKEN` — the same variable the runner's Claude backend
 * uses — or `ANTHROPIC_API_KEY`. Not a responder-specific secret. The design
 * records the reasoning and it is operational rather than aesthetic: a
 * separate credential is one more thing to provision, rotate and remember, and
 * credential rot is a *proven* outage cause in this system (an expired refresh
 * token and a stale encryption key have each taken out working components). A
 * responder disarmed by a credential nobody renewed is worse than one that
 * shares the platform's, and the shared-fate objection is answered by the
 * credential-free detector rule instead of by a second secret.
 *
 * An OAuth token goes on `Authorization: Bearer` with the
 * `anthropic-beta: oauth-2025-04-20` flag; an API key goes on `x-api-key`.
 * That is a header difference, not a key swap.
 */

import type { NarrativeCredential } from './config';
import type { Verdict } from './types';

const SYSTEM = [
  'You are writing a one-paragraph incident note for an on-call engineer.',
  'You are given deterministic detector output. Do not speculate beyond it.',
  'State what is broken, since when, and the single most likely place to look.',
  'No preamble, no headings, no bullet lists. Under 80 words.',
  'If the evidence does not support a cause, say which measurement would settle it.',
].join(' ');

export interface NarrativeContext {
  verdicts: Verdict[];
  appVersion: Record<string, unknown> | null;
  runnerVersion: Record<string, unknown> | null;
}

export function buildPrompt(ctx: NarrativeContext): string {
  return JSON.stringify(
    {
      firing: ctx.verdicts.map(v => ({
        detector: v.detector,
        state: v.state,
        onsetAt: v.onsetAt,
        summary: v.summary,
        facts: v.facts,
      })),
      deployedVersion: ctx.appVersion,
      runner: ctx.runnerVersion,
    },
    null,
    1,
  );
}

export type NarrateFn = (ctx: NarrativeContext) => Promise<string | null>;

/** A narrator for a responder with no model credential. Always null, never throws. */
export const noNarrator: NarrateFn = async () => null;

/**
 * Build a narrator over the Anthropic SDK.
 *
 * Wrapped end to end: a bad credential, a rate limit, a network partition, a
 * model that takes too long, an SDK that cannot even be imported — all of them
 * come back as `null`. The caller never has to decide whether a narrative
 * failure is worth a page, because it never is.
 */
export function modelNarrator(
  credential: NarrativeCredential,
  opts: { model: string; timeoutMs: number },
): NarrateFn {
  return async (ctx: NarrativeContext): Promise<string | null> => {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client =
        credential.kind === 'oauth'
          ? new Anthropic({
              authToken: credential.token,
              defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
              timeout: opts.timeoutMs,
              maxRetries: 0,
            })
          : new Anthropic({ apiKey: credential.token, timeout: opts.timeoutMs, maxRetries: 0 });

      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 512,
        system: SYSTEM,
        // Effort `low`: this is a short paragraph over structured input, not a
        // reasoning problem, and the page must not wait on depth it cannot use.
        ...({ output_config: { effort: 'low' } } as Record<string, unknown>),
        messages: [{ role: 'user', content: buildPrompt(ctx) }],
      });

      if (response.stop_reason === 'refusal') return null;
      // `content` is a discriminated union; narrow before reaching for `text`
      // so a thinking block cannot become an empty narrative.
      const text = response.content
        .flatMap(block => (block.type === 'text' ? [block.text.trim()] : []))
        .filter(Boolean)
        .join(' ');
      return text || null;
    } catch {
      // Deliberately total. No narrative is a cosmetic loss; a thrown error
      // here would be an outage report that never left the building.
      return null;
    }
  };
}

/**
 * Race the narrator against a hard wall clock.
 *
 * The SDK timeout above covers the HTTP request; this covers everything else
 * (a hung DNS lookup, a stalled dynamic import). The page is therefore at most
 * `timeoutMs` late and is never lost.
 */
export async function narrateWithinBudget(
  narrate: NarrateFn,
  ctx: NarrativeContext,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([narrate(ctx).catch(() => null), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
