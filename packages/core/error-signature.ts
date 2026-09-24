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
 *
 * It lives in `packages/core` rather than `apps/web/src/lib` (where it started)
 * so `gate-events.ts` can normalize `gate_events.reason` with the SAME function
 * the failure aggregation clusters worker errors with. A second copy would let
 * the two drift and split one family across two rows.
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
const RE_QUOTED_SLUG = /'([\w.]+(?:[-_/][\w.]+)+)'/g;
const RE_HEX_ID = /\b[0-9a-f]{7,}\b/gi;
const RE_NUMBER = /\d+(?:\.\d+)?/g;

// `[\s\S]*` rather than `.*`: a pretty-printed body spans lines, and `.` stops
// at a line terminator.
const RE_API_ERROR_ENVELOPE = /^API error: (\d+) - ([\s\S]*)$/;

export interface ApiErrorEnvelope {
  status: number;
  rawBody: string;
  /** The body's `error` string, or null when the body is not JSON carrying one. */
  message: string | null;
}

/**
 * Parse the `API error: <status> - <body>` text that the MCP/runner `api()`
 * helpers throw on a non-2xx response. Returns null for any other text.
 *
 * Older runners persisted that text verbatim as `workers.error`. Current ones
 * persist the server's prose `error` field (apps/runner/src/server-refusal.ts),
 * so without this unwrap one refusal family normalizes to two signatures
 * depending on which runner version wrote the row.
 *
 * Case-sensitive on purpose: the Claude CLI's own `API Error: …` (capital E)
 * is a different family and is left alone.
 */
export function unwrapApiErrorEnvelope(text: string | null | undefined): ApiErrorEnvelope | null {
  if (!text) return null;
  const m = text.match(RE_API_ERROR_ENVELOPE);
  if (!m) return null;
  const rawBody = m[2];
  let message: string | null = null;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error.trim()) {
      message = parsed.error;
    }
  } catch {
    // not JSON — caller keeps the original text
  }
  return { status: Number(m[1]), rawBody, message };
}

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
 *
 * RE_QUOTED_SLUG collapses single-quoted multi-segment tokens — branch names
 * (`buildd_ed211c59-consolidate-the-create-pr-bran`), mission-branch names
 * (`mission/spec-conformance-the-ledger-f02e0dc0-wcda33d93`), and similar
 * slug/path-shaped identifiers a route embeds verbatim in a 400 body (e.g.
 * "Task PR head '<branch>' does not match this worker's own branch
 * ('<branch>')"). Without it, four workers hitting the exact same
 * create_pr rejection produced four distinct signatures — one per embedded
 * branch name — invisible to both the ranked signature table and an exact
 * `error=` lookup, so the friction dedupe never fired. Matching requires a
 * `-`, `_`, or `/` separator inside the quotes, which is what distinguishes
 * a slug from a plain quoted field name like 'workspaceId' or 'apiKey' — the
 * character classes also exclude whitespace, so a contraction's apostrophe
 * (`You've`) can never pair with a later one across prose text.
 */
export function normalizeErrorSignature(error: string | null | undefined): string {
  if (!error) return EMPTY_SIGNATURE;

  // Legacy `API error: <n> - {"error":"…"}` rows cluster with the server's
  // prose, which is what current runners persist (see unwrapApiErrorEnvelope).
  const unwrapped = unwrapApiErrorEnvelope(error)?.message;
  if (unwrapped) error = unwrapped;

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
  s = s.replace(RE_QUOTED_SLUG, "'<id>'");
  s = s.replace(RE_HEX_ID, '<id>');
  s = s.replace(RE_NUMBER, '<n>');
  // Runs of placeholders (e.g. "<n> <n> <n>") add no signal.
  s = s.replace(/(?:<n> ){2,}<n>/g, '<n>').replace(/\s+/g, ' ').trim();

  if (s.length > MAX_SIGNATURE_LENGTH) {
    s = `${s.slice(0, MAX_SIGNATURE_LENGTH - 1)}…`;
  }
  return s.length > 0 ? s : EMPTY_SIGNATURE;
}
