/**
 * The core half of spec duplicates (Living Specs §13): what a check returns,
 * and the override a refused request may carry. The check itself is a Jev
 * decision (lib/spec-duplicate-decision.ts), reached through the modules slot
 * `SPEC_DUPLICATE_CHECK`, so core never imports the decisions module.
 */

export const SPEC_RELATIONS = ['duplicate', 'overlap', 'distinct'] as const;
export type SpecRelation = (typeof SPEC_RELATIONS)[number];

export interface DuplicateCandidate { specId: string; title: string; relation: SpecRelation; p: number; similarity: number; decisionRecordId: string | null }

export type DuplicateCheck =
  | { ran: true; blocking: DuplicateCandidate[]; warnings: DuplicateCandidate[]; compared: number }
  | { ran: false; reason: string };

export interface DuplicateCheckInput { workspaceId: string; title: string; body: string; userId?: string | null; accountId?: string | null }

export type DuplicateOverride = { supersedes?: string; distinctBecause?: string };

/** A refusal's override, checked: `supersedes` names a spec id, `distinctBecause` gives a reason of 10+ characters. */
export function parseDuplicateOverride(raw: { supersedes?: unknown; distinctBecause?: unknown }): DuplicateOverride | { error: string } | null {
  const out: DuplicateOverride = {};
  if (raw.supersedes !== undefined) {
    if (typeof raw.supersedes !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.supersedes)) return { error: 'supersedes must be the id of the spec this one replaces' };
    out.supersedes = raw.supersedes;
  }
  if (raw.distinctBecause !== undefined) {
    if (typeof raw.distinctBecause !== 'string' || raw.distinctBecause.trim().length < 10) return { error: 'distinctBecause must say, in at least 10 characters, why this spec is not a duplicate' };
    out.distinctBecause = raw.distinctBecause.trim().slice(0, 500);
  }
  return out.supersedes || out.distinctBecause ? out : null;
}
