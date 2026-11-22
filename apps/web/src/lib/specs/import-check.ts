import type { CriterionCheck } from '@buildd/spec-contract/check-lines';

/**
 * Import auto-confirm and the batch retirement proposal (Living Spec 65ed7fa3,
 * R-370 to R-372). This file holds the pure rules; ./import-check-store.ts
 * does the writes. Nothing here reads a caller's word about who approved.
 */

export type ImportCheckOutcome = 'pass' | 'fail' | 'error';
export interface ImportCheckResult { criterionId: string; outcome: ImportCheckOutcome }

export type ImportCheckDecision =
  | { kind: 'confirm' }
  | { kind: 'mismatch'; failed: ImportCheckResult[] }
  | { kind: 'none'; reason: 'no_checks' | 'not_run' };

/** R-370: confirm only when every `check:` line passed; any failure is one mismatch; a check not run yet waits. */
export function decideImportCheck(checks: readonly CriterionCheck[], results: readonly ImportCheckResult[]): ImportCheckDecision {
  if (checks.length === 0) return { kind: 'none', reason: 'no_checks' };
  const byId = new Map(results.map((r) => [r.criterionId, r.outcome]));
  const failed = checks.flatMap((c) => { const o = byId.get(c.criterionId); return o === 'fail' || o === 'error' ? [{ criterionId: c.criterionId, outcome: o }] : []; });
  if (failed.length) return { kind: 'mismatch', failed };
  return checks.every((c) => byId.get(c.criterionId) === 'pass') ? { kind: 'confirm' } : { kind: 'none', reason: 'not_run' };
}

/** R-371: one question for the spec, whatever number of checks failed. One sentence, with the answer we suggest. */
export function importMismatchQuestion(title: string, failed: readonly ImportCheckResult[]): { text: string; recommended: string } {
  const ids = failed.map((f) => f.criterionId).join(', ');
  return {
    text: `The code no longer matches "${title.replace(/[.!?]+/g, '')}" (checks failing: ${ids}); which one is right`,
    recommended: 'Change the spec to describe what the code does now',
  };
}

export interface RetirementItem { specId: string; title: string; reason: string }
const MIN_REASON = 10;
const MAX_REASON = 500;
const MAX_BATCH = 50;

/** R-372: an agent's list, checked against the live specs it may name. */
export function parseRetirementProposal(
  raw: unknown, live: ReadonlyArray<{ specId: string; title: string }>,
): { ok: true; items: RetirementItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'items is a non-empty list of { specId, reason }' };
  if (raw.length > MAX_BATCH) return { ok: false, error: `items holds at most ${MAX_BATCH} specs` };
  const titles = new Map(live.map((l) => [l.specId, l.title]));
  const seen = new Set<string>();
  const items: RetirementItem[] = [];
  for (const [i, r] of raw.entries()) {
    const specId = typeof (r as { specId?: unknown })?.specId === 'string' ? (r as { specId: string }).specId : '';
    const reason = typeof (r as { reason?: unknown })?.reason === 'string' ? (r as { reason: string }).reason.trim() : '';
    if (!titles.has(specId)) return { ok: false, error: `items[${i}] names a spec that is not live in this workspace` };
    if (seen.has(specId)) return { ok: false, error: `items[${i}] lists a spec twice` };
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) return { ok: false, error: `items[${i}].reason is ${MIN_REASON} to ${MAX_REASON} characters` };
    seen.add(specId);
    items.push({ specId, title: titles.get(specId)!, reason });
  }
  return { ok: true, items };
}

/** The owner's answer: everything listed (a plain yes), or only the kept ids. An id that was never listed is dropped. */
export function answerRetirementBatch(items: readonly RetirementItem[], keep: readonly string[] | undefined): RetirementItem[] {
  if (!keep) return [...items];
  const kept = new Set(keep);
  return items.filter((i) => kept.has(i.specId));
}

export const retirementBatchQuestion = (n: number) => ({
  text: `Retire ${n} spec${n === 1 ? '' : 's'} that look stale or superseded`,
  recommended: 'Yes, retire all of them',
});
