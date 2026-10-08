/**
 * Helpers the Scout adapters share: expectation clause parsing and evidence
 * ref shaping. Internal to `../executors` and its adapters.
 */

import type { VerificationEvidenceRef } from '../../verification-check';

/** `a; b`, `a, b`, `a and b` — the clauses of a journey's `expect`. */
const CLAUSE_SPLIT = /\s*(?:;|,|\band\b)\s*/i;
/** A quoted literal standing alone: `"…"`, `'…'` or `` `…` `` (an apostrophe inside a word is not a quote). */
const QUOTED = /(^|\s)(["'`])(.*?)\2(?=$|[\s;,])/g;

/** Split a journey's `expect` into clauses, never inside a quoted literal: `contains "build and test ok"` is one clause. */
export function splitClauses(raw: string): string[] {
  const quoted: string[] = [];
  const masked = raw.trim().replace(QUOTED, (_m, lead: string, q: string, body: string) => `${lead}${q}\u0000${quoted.push(body) - 1}\u0000${q}`);
  return masked
    .split(CLAUSE_SPLIT)
    .filter(Boolean)
    .map((clause) => clause.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => quoted[Number(i)]));
}

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
