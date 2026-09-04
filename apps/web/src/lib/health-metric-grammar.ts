/**
 * The grammar the Health page states its numbers in.
 *
 * Health renders four classes of number, and the bug this module exists to
 * prevent is rendering one class in another's clothes:
 *
 *  - STATE       true right now. Renders FRESHNESS (`as of 3h ago`), never a window.
 *  - TREND       only meaningful over a period. Renders the page WINDOW, never freshness.
 *  - LIFETIME    a cumulative counter or streak. Renders `since <anchor>`, and must
 *                never appear to obey `?window=`, because it does not.
 *  - PROJECTION  a trailing rate applied forward. Renders the value AND the window
 *                the rate came from, in one string, so the two can't be separated.
 *
 * Every helper here is pure and clock-injected — `now` is a parameter, never
 * `Date.now()`, both so the strings are testable and because freshness must be
 * measured from the stat's own timestamp rather than from page-render time.
 *
 * See `docs/design/derived-metric-availability.md` for the sibling contract: no
 * stat renders a value or a bare dash without a reachable reason at that stat.
 */
import { normalizeErrorSignature } from './error-signature';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ── STATE: freshness ─────────────────────────────────────────────────────────

/**
 * `as of {N}{m|h|d} ago` from the stat's OWN last-observed timestamp.
 *
 * A null timestamp renders `never observed`. It must never fall back to "now" or
 * to the page-render time: a stat that was never observed would then claim to be
 * perfectly fresh, which is the exact inversion of the truth.
 */
export function freshness(iso: string | null | undefined, now: number): string {
  const at = observedAgo(iso, now);
  return at === null ? 'never observed' : `as of ${at}`;
}

/** The `{N}{m|h|d} ago` half of `freshness`, or null when never observed. */
export function observedAgo(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const ms = now - t;
  // A clock-skewed future timestamp is still an observation; "just now" is the
  // honest reading of it, and a negative age would be nonsense.
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

// ── TREND: coverage ──────────────────────────────────────────────────────────

export interface CoverageInput {
  /** Rows attribution actually covers. */
  covered: number;
  /** Population size. */
  population: number;
  /**
   * True when any counted row was reconstructed rather than measured exactly.
   * A derived row makes `covered` a FLOOR, which `{n}/{N}` alone cannot say —
   * it reads identically to an exact count.
   */
  hasDerived?: boolean;
}

/**
 * Three-state coverage: exact `{n}/{N}`, or `≥{n}/{N}` when any row is derived.
 *
 * This is the ATTRIBUTION axis only. Scan truncation — the population itself
 * being capped — is a separate, orthogonal caveat (`scanCaveat` in
 * `model-presentation.ts`) and both are shown; neither replaces the other.
 */
export function coverageLabel({ covered, population, hasDerived }: CoverageInput): string {
  return `${hasDerived ? '≥' : ''}${covered}/${population}`;
}

/**
 * A section's own denominator: `over {N} {population}`.
 *
 * Declared per section on purpose. Health renders four populations (workers,
 * terminal worker sessions, tasks, runners) and one page-wide denominator would
 * be false for three of them.
 */
export function sectionDenominator(count: number, population: string): string {
  return `over ${count} ${population}`;
}

// ── LIFETIME ─────────────────────────────────────────────────────────────────

/** `{N} runs since created` — a schedule's all-time counter, never windowed. */
export function lifetimeRuns(totalRuns: number): string {
  return `${totalRuns} run${totalRuns === 1 ? '' : 's'} since created`;
}

/** `{N} in a row` — a streak reads as a streak, not as a count over a window. */
export function failureStreak(consecutiveFailures: number): string {
  return `${consecutiveFailures} in a row`;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * `since {Mon} 1` — the calendar anchor a monthly budget accumulates from.
 *
 * Derived from the reset instant, which is the START of the next period, so the
 * period actually being reported is the month before it.
 */
export function monthlyAnchor(resetsAtIso: string): string {
  const reset = new Date(resetsAtIso);
  if (!Number.isFinite(reset.getTime())) return 'this month';
  const start = new Date(Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() - 1, 1));
  return `since ${MONTHS[start.getUTCMonth()]} 1`;
}

/** `all-time, this runner` — runner-local SQLite has no team/workspace predicate. */
export const RUNNER_LIFETIME_LABEL = 'all-time, this runner';

// ── PROJECTION ───────────────────────────────────────────────────────────────

/**
 * `depletes in {N}d · from {window} burn` — value and rate-window in one string.
 *
 * Deliberately inseparable: a runway rendered without the window it was
 * extrapolated from invites the reader to assume it obeys the page window.
 */
export function depletionProjection(
  daysToDepletion: number | null,
  rateWindow: string,
): string | null {
  if (daysToDepletion === null || !Number.isFinite(daysToDepletion)) return null;
  const value = daysToDepletion < 1
    ? `${Math.round(daysToDepletion * 24)}h`
    : `${daysToDepletion.toFixed(1)}d`;
  return `depletes in ${value} · from ${rateWindow} burn`;
}

// ── Problems: failure grouping ───────────────────────────────────────────────

/** The minimum a row needs to be grouped. Shaped structurally so the page's
 *  `RecentFailure` satisfies it without this module importing from a route. */
export interface GroupableFailure {
  error: string | null;
  /** ISO timestamp of the failure. */
  completedAt: string;
}

export interface FailureGroup<T extends GroupableFailure> {
  /** Cluster key from `normalizeErrorSignature` — the SAME key the failure
   *  signature table below Problems ranks on, so the two agree. */
  signature: string;
  count: number;
  /** ISO timestamp of the most recent member. */
  lastSeen: string;
  /** The most recent member, for linking. */
  sample: T;
}

export interface GroupedFailures<T extends GroupableFailure> {
  groups: FailureGroup<T>[];
  /** Groups beyond the cap. */
  hiddenGroups: number;
  /** Failures inside those groups — `+N more` counts failures, not clusters. */
  hiddenFailures: number;
  /** Every failure considered, i.e. the section's denominator. */
  total: number;
}

/**
 * Cluster failures by normalized error signature, worst-first, capped.
 *
 * Reuses `normalizeErrorSignature` rather than inventing a cause+batch key:
 * Problems sits directly above the signature-ranked failure table, and two
 * different grouping keys on one page produce two different counts for the same
 * incident.
 */
export function groupFailuresBySignature<T extends GroupableFailure>(
  rows: T[],
  cap = 5,
): GroupedFailures<T> {
  const byKey = new Map<string, FailureGroup<T>>();

  for (const row of rows) {
    const signature = normalizeErrorSignature(row.error);
    const existing = byKey.get(signature);
    if (!existing) {
      byKey.set(signature, { signature, count: 1, lastSeen: row.completedAt, sample: row });
      continue;
    }
    existing.count += 1;
    if (row.completedAt > existing.lastSeen) {
      existing.lastSeen = row.completedAt;
      existing.sample = row;
    }
  }

  const ordered = [...byKey.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.lastSeen.localeCompare(a.lastSeen) ||
      a.signature.localeCompare(b.signature),
  );
  const shown = ordered.slice(0, cap);
  const hidden = ordered.slice(cap);

  return {
    groups: shown,
    hiddenGroups: hidden.length,
    hiddenFailures: hidden.reduce((sum, g) => sum + g.count, 0),
    total: rows.length,
  };
}
