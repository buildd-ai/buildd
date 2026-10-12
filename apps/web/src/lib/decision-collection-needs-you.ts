/**
 * Home's card for a decision feature that stopped deciding.
 *
 * A feature that was asked over the last 24 hours and never once got a model
 * answer (every row a fallback before the model spoke, or no key to ask with)
 * is broken in a way no other surface shows: its rows look like normal
 * fallbacks. This raises one card per such feature for the platform operator
 * (gated in the Home page like every other card, and pulled, never pushed),
 * titled with the feature and carrying the plain-words fix from
 * packages/core/decision-feature-health.ts. A feature nobody asked is idle,
 * not broken, and one a team switched off is a choice: neither raises.
 *
 * It rides the incident card path (kind 'incident', subject
 * `incident:decision-feature:<id>`), which links out instead of acting.
 */
import { computeFeatureHealth, isNotCollecting, type HealthRow } from '@buildd/core/decision-feature-health';
import { INFERENCE_CAPABILITIES, type InferenceCapability } from '@buildd/core/inference-policy';
import type { WaitingOnYouRawItem } from './action-queue';

export const DECISION_FEATURES_HREF = '/app/settings/models';
const WINDOW_MS = 24 * 3_600_000;
const ROW_LIMIT = 20_000;

type Row = HealthRow & { capability: string };

const featureLabel = (capability: string) =>
  (INFERENCE_CAPABILITIES as Record<string, { label: string } | undefined>)[capability as InferenceCapability]?.label ?? capability;

export function decisionCollectionNeedsYouItems(rows: readonly Row[]): WaitingOnYouRawItem[] {
  const byCapability = new Map<string, Row[]>();
  for (const r of rows) byCapability.set(r.capability, [...(byCapability.get(r.capability) ?? []), r]);
  const items: WaitingOnYouRawItem[] = [];
  for (const [capability, list] of [...byCapability].sort((a, b) => a[0].localeCompare(b[0]))) {
    const health = computeFeatureHealth(list, []);
    if (!isNotCollecting(health)) continue;
    items.push({
      kind: 'incident',
      incidentId: `decision-feature:${capability}`,
      incidentTitle: `${featureLabel(capability)} is not deciding`,
      failureMessage: health.collection.sentence,
      fixHref: DECISION_FEATURES_HREF,
      fixLabel: 'Open decision features',
    });
  }
  return items;
}

/** Platform-wide: the last 24 hours of the decision ledger. Never throws (Home keeps every other card). */
export async function loadDecisionCollectionNeedsYou(now = Date.now()): Promise<WaitingOnYouRawItem[]> {
  try {
    const [{ db }, { decisionRecords }, { desc, gte }] = await Promise.all([
      import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
    ]);
    const rows = await db.select({
      id: decisionRecords.id, capability: decisionRecords.capability, status: decisionRecords.status, applied: decisionRecords.applied,
      verdict: decisionRecords.verdict, reason: decisionRecords.reason, latencyMs: decisionRecords.latencyMs, costUsd: decisionRecords.costUsd,
    }).from(decisionRecords)
      .where(gte(decisionRecords.createdAt, new Date(now - WINDOW_MS)))
      .orderBy(desc(decisionRecords.createdAt))
      .limit(ROW_LIMIT);
    return decisionCollectionNeedsYouItems(rows.map(r => ({ ...r, overridden: false })));
  } catch (err) {
    console.warn('[decision-collection] Home read failed (non-fatal):', (err as Error)?.message ?? err);
    return [];
  }
}
