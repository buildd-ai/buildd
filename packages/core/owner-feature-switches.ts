/**
 * Storage for the platform owner's per-feature switch (`decision_feature_modes`):
 * recording only, or acting. What the switch means, and which features have
 * one, is packages/core/decision-feature-modes.ts; this file only reads and
 * writes the rows, so core call sites (the creation-manifest path) can read
 * them without importing the admin-facing module.
 *
 * Reads are cached per instance for a minute and never throw: a failed read is
 * "no rows", which is every feature's code default.
 */
export type DecisionFeatureMode = 'acting' | 'recording';

export interface StoredFeatureMode {
  feature: string;
  mode: DecisionFeatureMode;
  applyingFraction: number;
  measuredFingerprint: string | null;
  threshold: number | null;
  setByAccountId: string | null;
  setAt: Date;
  reason: string | null;
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; rows: Map<string, StoredFeatureMode> } | null = null;

/** Drop the per-instance cache (after a write in this instance, and in tests). */
export function clearDecisionFeatureModeCache(): void { cache = null; }

/** Every stored row, cached for a minute. Never throws: a failed read is no rows. */
export async function loadDecisionFeatureModes(now: () => number = Date.now): Promise<Map<string, StoredFeatureMode>> {
  const t = now();
  if (cache && t - cache.at < CACHE_TTL_MS) return cache.rows;
  try {
    const { db } = await import('./db');
    const { decisionFeatureModes } = await import('./db/schema');
    const rows = await db.select().from(decisionFeatureModes);
    const map = new Map<string, StoredFeatureMode>(rows.map(r => [r.feature, { ...r, mode: r.mode as DecisionFeatureMode }]));
    cache = { at: t, rows: map };
    return map;
  } catch (err) {
    console.warn('[decision-feature-modes] read failed, using code defaults:', (err as Error)?.message ?? err);
    return new Map();
  }
}

export async function loadDecisionFeatureMode(feature: string): Promise<StoredFeatureMode | null> {
  return (await loadDecisionFeatureModes()).get(feature) ?? null;
}

/** Upsert one feature's row. Throws on a failed write (the route answers 500). */
export async function writeDecisionFeatureMode(row: Omit<StoredFeatureMode, 'setAt'>): Promise<StoredFeatureMode> {
  const { db } = await import('./db');
  const { decisionFeatureModes } = await import('./db/schema');
  const setAt = new Date();
  const values = { ...row, setAt };
  await db.insert(decisionFeatureModes).values(values).onConflictDoUpdate({
    target: decisionFeatureModes.feature,
    set: {
      mode: values.mode,
      applyingFraction: values.applyingFraction,
      measuredFingerprint: values.measuredFingerprint,
      threshold: values.threshold,
      setByAccountId: values.setByAccountId,
      setAt,
      reason: values.reason,
    },
  });
  clearDecisionFeatureModeCache();
  return values;
}
