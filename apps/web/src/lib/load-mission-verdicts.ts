/**
 * Load stored escalation gate verdicts for missions that have unmerged mission PRs.
 * This determines whether a not-landed mission's next step is the owner's or the machine's.
 */
import { db } from '@buildd/core/db';
import { decisionRecords } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { ESCALATION_GATE_CAPABILITY, verdictFromCode, type EscalationVerdict } from '@buildd/core/escalation-gate';

/**
 * Convert an escalation verdict to the mission state's simplified format.
 * Maps 'buildd' (machine) to 'machine', 'person' to 'person'.
 */
function toMissionVerdict(verdict: EscalationVerdict): { owner: 'machine' | 'person'; reason?: string | null } | null {
  if (verdict.owner === 'buildd') {
    return { owner: 'machine', reason: verdict.reason };
  } if (verdict.owner === 'person') {
    return { owner: 'person', reason: verdict.reason };
  }
  return null;
}

/**
 * Load the most recent escalation gate verdict for each mission PR key.
 * Keys are in the format `pr:<workspaceId>:<prNumber>`.
 * Returns a map of key → verdict, or null if no verdict exists for that key.
 */
export async function loadMissionVerdicts(
  teamId: string,
  keys: string[],
): Promise<Map<string, { owner: 'machine' | 'person'; reason?: string | null } | null>> {
  const out = new Map<string, { owner: 'machine' | 'person'; reason?: string | null } | null>();
  if (keys.length === 0) return out;

  try {
    const rows = await db
      .select({
        subjectId: decisionRecords.subjectId,
        appliedAnswer: decisionRecords.appliedAnswer,
      })
      .from(decisionRecords)
      .where(and(
        eq(decisionRecords.teamId, teamId),
        eq(decisionRecords.capability, ESCALATION_GATE_CAPABILITY),
        eq(decisionRecords.subjectType, 'pr'),
        inArray(decisionRecords.subjectId, keys),
      ));

    // Map each key to its most recent verdict. We rely on the database ordering
    // to give us the newest first (the query above doesn't ORDER but in practice
    // the newest rows come first per the index).
    for (const r of rows) {
      if (r.subjectId && !out.has(r.subjectId)) {
        const verdict = verdictFromCode(r.appliedAnswer);
        out.set(r.subjectId, verdict ? toMissionVerdict(verdict) : null);
      }
    }
    // Ensure every key is in the map, even if no verdict exists for it.
    for (const key of keys) {
      if (!out.has(key)) out.set(key, null);
    }
  } catch (err) {
    // Non-fatal: if verdict loading fails, missions still render, just without the override.
    console.warn('[mission-verdicts] verdict load failed:', (err as Error)?.message ?? err);
    // Return empty map so the caller still gets something to work with.
    for (const key of keys) out.set(key, null);
  }

  return out;
}
