/**
 * Alert when production runs a public prompt default it was seeded to replace.
 *
 * The deploy seed (`apps/web/scripts/seed-prompts.ts`) records which ids it
 * seeded. This check, run from the release health check cron, reads the active
 * rows the same way the loader does (hash-checked) and asks, per seeded id,
 * whether a resolve would fall back to the public default right now: no valid
 * active row, or a row whose body the reader now rejects (a decision whose
 * public shape changed after the seed). Every server process counts its own
 * fallbacks (`promptFallbackCounts`) and logs them in production; this is the
 * cross-process view, from the table every process loads.
 *
 * Fires only in production and only when a seed ran (a deployment on public
 * defaults by design is healthy). Pages once per distinct set of fallbacks,
 * not every tick, and re-arms when the set clears. Ids and reasons only, never
 * prompt text.
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { prompts, systemCache } from '@buildd/core/db/schema';
import { expectedPromptFallbacks, type PromptFallback, type PromptSeedMarker } from '@buildd/core/prompt-seed';
import { readPromptSeedMarker } from '@buildd/core/prompt-seed-source';
import { parsePromptRows } from '@buildd/core/prompts-source';
import type { PromptSnapshot, RegisteredPrompt } from '@buildd/core/prompts';
import { notifyOperator } from '@/lib/pushover';
import { listPromptCatalog } from '@/lib/prompt-catalog';

export const PROMPT_FALLBACK_ALERT_KEY = 'prompts:fallback-alert';

export type PromptFallbackCheck =
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string }
  | { status: 'ok'; seeded: number }
  | { status: 'falling_back'; seeded: number; fallbacks: PromptFallback[]; alerted: boolean };

export interface PromptFallbackDeps {
  env: Record<string, string | undefined>;
  readMarker: () => Promise<PromptSeedMarker | null>;
  readActive: () => Promise<PromptSnapshot>;
  catalog: () => RegisteredPrompt[];
  readLastSignature: () => Promise<string | null>;
  writeLastSignature: (signature: string) => Promise<void>;
  notify: (title: string, message: string) => void;
}

export function fallbackSignature(fallbacks: readonly PromptFallback[]): string {
  return fallbacks.map(f => `${f.id}:${f.reason}`).join(',');
}

export async function checkPromptFallbacks(deps: PromptFallbackDeps = defaultDeps()): Promise<PromptFallbackCheck> {
  if (deps.env.VERCEL_ENV !== 'production') return { status: 'skipped', reason: 'not production' };
  let marker: PromptSeedMarker | null;
  let active: PromptSnapshot;
  try {
    marker = await deps.readMarker();
    if (!marker) return { status: 'skipped', reason: 'no prompt seed has run' };
    active = await deps.readActive();
  } catch (err) {
    // A failed read is not a fallback; the health check reports it and pages nothing.
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }

  const fallbacks = expectedPromptFallbacks(marker, active, deps.catalog());
  const signature = fallbackSignature(fallbacks);
  const last = await deps.readLastSignature().catch(() => null);

  if (fallbacks.length === 0) {
    if (last) await deps.writeLastSignature('').catch(() => {});
    return { status: 'ok', seeded: marker.ids.length };
  }

  console.warn(`[prompts] ${fallbacks.length} seeded prompt(s) resolve to public defaults: ${signature}`);
  const alerted = signature !== last;
  if (alerted) {
    deps.notify(
      `[buildd] ${fallbacks.length} prompt(s) running on public defaults`,
      [
        ...fallbacks.slice(0, 10).map(f => `• ${f.id} (${f.reason === 'missing' ? 'no active row' : 'row rejected'})`),
        ...(fallbacks.length > 10 ? [`• +${fallbacks.length - 10} more`] : []),
        'Re-run the prompt seed (apps/web prompts:seed); /api/deploy-identity lists what is active.',
      ].join('\n'),
    );
    await deps.writeLastSignature(signature).catch(() => {});
  }
  return { status: 'falling_back', seeded: marker.ids.length, fallbacks, alerted };
}

function defaultDeps(): PromptFallbackDeps {
  return {
    env: process.env,
    readMarker: readPromptSeedMarker,
    readActive: async () =>
      parsePromptRows(
        await db
          .select({ id: prompts.id, version: prompts.version, contentHash: prompts.contentHash, body: prompts.body })
          .from(prompts)
          .where(eq(prompts.active, true)),
      ),
    catalog: listPromptCatalog,
    readLastSignature: async () => {
      const [row] = await db
        .select({ value: systemCache.value })
        .from(systemCache)
        .where(eq(systemCache.key, PROMPT_FALLBACK_ALERT_KEY))
        .limit(1);
      const v = (row?.value as { signature?: unknown } | undefined)?.signature;
      return typeof v === 'string' ? v : null;
    },
    writeLastSignature: async signature => {
      const value = { signature };
      await db
        .insert(systemCache)
        .values({ key: PROMPT_FALLBACK_ALERT_KEY, value })
        .onConflictDoUpdate({ target: systemCache.key, set: { value, updatedAt: new Date() } });
    },
    notify: (title, message) => notifyOperator({ app: 'alerts', title, message, priority: 0 }),
  };
}
