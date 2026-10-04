/**
 * The DB side of the prompt seed (`prompt-seed.ts`): read the table's rows,
 * apply a plan, record what was seeded, and read that record back.
 *
 * No transaction (neon-http has none): every write is a single idempotent
 * statement, so a seed interrupted halfway is finished by the next run. An
 * activation deactivates the id's other active row first (the partial unique
 * index allows one), so an id can briefly have no active row and resolve to
 * its public default; never two.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from './db/client';
import { prompts, systemCache } from './db/schema';
import {
  PROMPT_SEED_MARKER_KEY,
  parsePromptSeedMarker,
  type ExistingPromptRow,
  type PromptSeedAction,
  type PromptSeedMarker,
} from './prompt-seed';

export async function readPromptRows(): Promise<ExistingPromptRow[]> {
  return db
    .select({ id: prompts.id, version: prompts.version, contentHash: prompts.contentHash, active: prompts.active })
    .from(prompts);
}

export async function applyPromptSeed(actions: readonly PromptSeedAction[]): Promise<void> {
  for (const a of actions) {
    if (a.type === 'insert') {
      await db
        .insert(prompts)
        .values({ id: a.entry.id, version: a.entry.version, contentHash: a.entry.contentHash, body: a.entry.body, active: false })
        .onConflictDoNothing();
    } else if (a.type === 'activate') {
      await db
        .update(prompts)
        .set({ active: false })
        .where(and(eq(prompts.id, a.id), eq(prompts.active, true), ne(prompts.version, a.version)));
      await db
        .update(prompts)
        .set({ active: true })
        .where(and(eq(prompts.id, a.id), eq(prompts.version, a.version)));
    } else if (a.type === 'deactivate') {
      await db.update(prompts).set({ active: false }).where(and(eq(prompts.id, a.id), eq(prompts.active, true)));
    }
  }
}

export async function writePromptSeedMarker(marker: PromptSeedMarker): Promise<void> {
  await db
    .insert(systemCache)
    .values({ key: PROMPT_SEED_MARKER_KEY, value: marker })
    .onConflictDoUpdate({ target: systemCache.key, set: { value: marker, updatedAt: new Date() } });
}

/** The last seed's record, or null when this deployment was never seeded (or the read failed). */
export async function readPromptSeedMarker(): Promise<PromptSeedMarker | null> {
  try {
    const [row] = await db
      .select({ value: systemCache.value })
      .from(systemCache)
      .where(eq(systemCache.key, PROMPT_SEED_MARKER_KEY))
      .limit(1);
    return parsePromptSeedMarker(row?.value ?? null);
  } catch {
    return null;
  }
}
