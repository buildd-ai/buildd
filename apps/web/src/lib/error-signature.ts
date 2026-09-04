/**
 * Pure, dependency-free worker-error-signature normalization.
 *
 * This module MUST NOT import the DB (or anything that transitively pulls in
 * `@buildd/core/db` → `packages/core/config.ts` → `dotenv.config()`), because
 * it is imported by client components (via `health-metric-grammar.ts`, used
 * by `HealthClient.tsx`). `dotenv.config()` reads `process.stdout.isTTY`,
 * which is undefined in the browser and throws `Cannot read properties of
 * undefined (reading 'isTTY')` during module evaluation — taking down the
 * whole client bundle and every page that ships it. Keep DB access in
 * `failure-analytics.ts`, which re-exports from here for server-side callers.
 */

/** Placeholder signature for failures that carry no error text at all. */
export const EMPTY_SIGNATURE = '(no error message)';

/** Signatures are bounded so a runaway stack trace can't become a table row. */
const MAX_SIGNATURE_LENGTH = 200;

const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const RE_ISO_TS = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const RE_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const RE_CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:[ap]m)?|\b\d{1,2}\s?[ap]m\b/gi;
const RE_PATH = /(?:\/[\w.@+-]+){2,}\/?/g;
const RE_HEX_ID = /\b[0-9a-f]{7,}\b/gi;
const RE_NUMBER = /\d+(?:\.\d+)?/g;

/**
 * Collapse a raw worker error into a stable cluster key.
 *
 * Volatile detail (ids, hosts, paths, timestamps, counts) is replaced by
 * placeholders so recurring platform failures collapse into one row:
 *
 *   "Deferred: another Codex worker (d7e6…) is already active in this workspace"
 *     → "Deferred: another Codex worker (<id>) is already active in this workspace"
 *   "Stale worker expired (no update for 15+ minutes)"
 *     → "Stale worker expired (no update for <n>+ minutes)"
 *
 * Replacement order matters: URLs before paths (URLs contain slashes), and
 * timestamps/clock times before the generic number pass.
 *
 * The clock rule matches BOTH `1:20pm` and a bare-hour `3pm` / `3 PM`. Requiring
 * `H:MM` once split one real failure mode ("resets <time>") into three rows,
 * because whole-hour resets fell through to the numeric rule as `<n>pm`. The
 * bare-hour branch requires a meridiem, so a plain count ("3 attempts") stays
 * `<n>` and does not over-collapse into `<time>`.
 *
 * Full UUIDs and truncated hex IDs BOTH collapse to `<id>`. They used to get
 * `<id>` and `<hash>` respectively, which split one family in two whenever an
 * agent logged a short task ID in one message and the full UUID in another —
 * the same entity reported as two rows. A reader of a failure table cannot
 * usefully act on "hash vs id", so one placeholder is strictly better than a
 * third rule guessing which hex strings are identifiers.
 *
 * RE_UUID must stay AHEAD of RE_HEX_ID: the hex rule would otherwise eat the
 * first group out of a full UUID and leave `<id>-0be1-4d2c-b10d-<id>`.
 */
export function normalizeErrorSignature(error: string | null | undefined): string {
  if (!error) return EMPTY_SIGNATURE;

  // Multi-line errors: the first non-empty line is the failure; the rest is trace.
  const firstLine = error.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (!firstLine) return EMPTY_SIGNATURE;

  let s = firstLine.replace(/\s+/g, ' ').trim();

  s = s.replace(RE_URL, '<url>');
  s = s.replace(RE_UUID, '<id>');
  s = s.replace(RE_ISO_TS, '<ts>');
  s = s.replace(RE_DATE, '<ts>');
  s = s.replace(RE_CLOCK, '<time>');
  s = s.replace(RE_PATH, '<path>');
  s = s.replace(RE_HEX_ID, '<id>');
  s = s.replace(RE_NUMBER, '<n>');
  // Runs of placeholders (e.g. "<n> <n> <n>") add no signal.
  s = s.replace(/(?:<n> ){2,}<n>/g, '<n>').replace(/\s+/g, ' ').trim();

  if (s.length > MAX_SIGNATURE_LENGTH) {
    s = `${s.slice(0, MAX_SIGNATURE_LENGTH - 1)}…`;
  }
  return s.length > 0 ? s : EMPTY_SIGNATURE;
}
