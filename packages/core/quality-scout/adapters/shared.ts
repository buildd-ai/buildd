/**
 * Helpers the Scout adapters share: expectation clause parsing and evidence
 * ref shaping. Internal to `../executors` and its adapters.
 */

import type { VerificationEvidenceRef } from '../../verification-check';

/** `a; b`, `a, b`, `a and b` — the clauses of a journey's `expect`. */
export const CLAUSE_SPLIT = /\s*(?:;|,|\band\b)\s*/i;
/** `contains "x"`, `stdout includes x`, `body contains 'x'`. */
export const CONTAINS = /^(?:(?:stdout|output|body|response)\s+)?(?:contains|includes)\s+["'`]?(.+?)["'`]?$/i;

const TAIL = 200;

/** Whitespace-collapsed last 200 chars — what an `observed` line may quote. */
export const tail = (s: string | undefined | null) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > TAIL ? `…${t.slice(-TAIL)}` : t;
};

export const evidenceRefs = (kind: string, ...r: Array<string | null | undefined>): VerificationEvidenceRef[] =>
  r.filter((x): x is string => typeof x === 'string' && x.length > 0).map((ref) => ({ kind, ref }));
