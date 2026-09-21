/**
 * The registry of platform signals that are claimed to be able to FIRE.
 *
 * A 23-day audit found five signals that were structurally incapable of
 * reporting a problem — not noisy, not badly tuned, unable to trip at all
 * (CBM health predicate, the claim-loop stranding detector, `supportedModels()`
 * capability validation, the 24h worker TTL, and a disk-space alert in the
 * infrastructure repo). Each one read as "covered" — a predicate existed, a
 * threshold existed, an alert path existed — while producing zero true
 * positives for weeks. The convention this registry exists to enforce:
 *
 *   A signal without a test proving it can FIRE is not a signal.
 *
 * Every entry below names what the signal watches, its threshold, and where
 * the proof lives. `scripts/signal-fire-coverage.test.ts` enforces this
 * bidirectionally against `git ls-files`: a registered signal with no marked
 * fire-test fails the build, and so does a marked fire-test for a slug this
 * file does not list.
 *
 * An entry with no fire-test reachable from THIS repo state — either because
 * the implementation lives in another repository, or because the fix already
 * landed on a different, uncommitted branch this PR must not collide with —
 * sets `noLocalFireTest` instead of `fireTest`. The coverage test requires a
 * tracking reference in its place rather than silently exempting the entry.
 */

/**
 * The exact marker a fire-test must carry, immediately above the `it`/`test`
 * block that proves a registered signal fires, followed by the entry's slug
 * (e.g. `${SIGNAL_FIRE_MARKER_PREFIX} cbm-fleet-health`).
 *
 * Kept as the single literal definition of the marker text on purpose: the
 * coverage test that scans for it imports this constant rather than
 * respelling the marker itself, so the marker text appears verbatim in
 * exactly the files that are actually claiming to prove a signal fires — never
 * in the scanner's own source, where a literal copy would self-match as a
 * phantom marker the moment the scanner's own file is included in the scan.
 */
export const SIGNAL_FIRE_MARKER_PREFIX = '@signal-fire:';

/** Build the exact marker comment text for a slug, e.g. `@signal-fire: foo`. */
export function formatSignalFireMarker(slug: string): string {
  return `${SIGNAL_FIRE_MARKER_PREFIX} ${slug}`;
}

/**
 * The marker-matching pattern, built from SIGNAL_FIRE_MARKER_PREFIX rather
 * than a respelled literal.
 *
 * The captured slug is restricted to kebab-case (`[a-z0-9]+(-[a-z0-9]+)*`) on
 * purpose, not just `\S+`: a docstring that mentions the marker in prose —
 * `` `@signal-fire:` marker `` — is followed by a backtick or punctuation,
 * never by a slug-shaped token, so it cannot satisfy this pattern. Loosening
 * this to "any non-whitespace" is exactly what let this checker's own doc
 * comments register as phantom markers during development.
 */
export function signalFireMarkerPattern(): RegExp {
  const escaped = SIGNAL_FIRE_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}[ \\t]*([a-z0-9]+(?:-[a-z0-9]+)*)`, 'g');
}

/** Extract every slug referenced by a marker comment in `source`, in order of appearance. */
export function parseSignalFireMarkers(source: string): string[] {
  return [...source.matchAll(signalFireMarkerPattern())].map(m => m[1]);
}

export interface SignalFireTest {
  /** Repo-relative path to the test file containing the marked test. */
  file: string;
  /** Exact `it`/`test` title of the block carrying the marker comment. */
  title: string;
}

export interface SignalRegistryEntry {
  /** Unique kebab-case identifier, referenced by the marker comment. */
  slug: string;
  /** Human name of the signal. */
  name: string;
  /** What the signal watches. */
  watches: string;
  /** The threshold that decides whether it fires, and why that value. */
  threshold: string;
  /** Where the signal is implemented: `file.ts#symbol`. */
  location: string;
  /**
   * Set when no fire-test for this signal is reachable from this repo state.
   * The coverage test requires this in place of `fireTest` — naming why, and
   * where the fix is actually tracked — rather than silently skipping the
   * entry.
   */
  noLocalFireTest?: { reason: string; trackedBy: string };
  /** Required unless `noLocalFireTest` is set. */
  fireTest?: SignalFireTest;
}

export const SIGNAL_REGISTRY: SignalRegistryEntry[] = [
  {
    slug: 'cbm-fleet-health',
    name: 'CBM fleet health predicate',
    watches: 'Whether the last CBM_FLEET_THRESHOLD terminal workers in a workspace all report an unhealthy CBM outcome',
    threshold:
      "CBM_FLEET_THRESHOLD (5) consecutive terminal workers unhealthy — outcome='disabled' OR " +
      "(outcome='enforced' AND bootstrapResult='failed'). Previously only outcome='disabled' counted, " +
      "so a fleet where every index bootstrap failed reported 100% healthy (bootstrapResult is set " +
      'unconditionally to enforced once CBM mounts, independent of whether indexing succeeded).',
    location: 'packages/core/cbm-health.ts#detectCbmFleetDisabled',
    fireTest: {
      file: 'packages/core/__tests__/cbm-health.test.ts',
      title: 'fires when enforced workers all report a failed index bootstrap',
    },
  },
  {
    slug: 'claim-loop-stranding',
    name: 'Claim-loop stranding detector',
    watches: 'Pending tasks stuck behind a claim-loop gate deferral, or past their own startAt',
    threshold:
      'STRAND_MS (2h) elapsed since detail.firstDeferredAt, with a MIN_CONSECUTIVE_DEFERRALS (2) noise ' +
      'floor. Previously keyed on consecutiveDeferrals >= 200 alone, sized against an assumed ~30s runner ' +
      'poll; the measured p50 claim cadence is over five minutes, so 200 consecutive polls was many hours ' +
      'further away than any stuck task in the audit window ever reached — the threshold could not trip.',
    location: 'apps/web/src/lib/stranded-tasks-sweep.ts#sweepStrandedTasks',
    fireTest: {
      file: 'apps/web/src/lib/stranded-tasks-sweep.test.ts',
      title: 'flags a task via a stale deferral streak when it has no startAt at all',
    },
  },
  {
    slug: 'model-capability-validation',
    name: 'supportedModels() capability validation',
    watches: "A task's configured effort/thinking against what the SDK's supportedModels() reports for the model actually running",
    threshold:
      'Any mismatch between configured effort/thinking and the matched ModelInfo row emits a warning. ' +
      "Previously the lookup compared the running model id only against ModelInfo.value (the model ALIAS, " +
      "e.g. 'sonnet') and never against ModelInfo.resolvedModel (the wire id, e.g. 'claude-sonnet-5') that " +
      'fleet tasks are actually configured with — every lookup missed, for every model, and zero warnings ' +
      'were ever emitted.',
    location: 'apps/runner/src/prompt-builder.ts#discoverModelCapabilities',
    fireTest: {
      file: 'apps/runner/__tests__/unit/model-capability-discovery.test.ts',
      title: 'matches a session running on the wire id against the alias row via resolvedModel',
    },
  },
  {
    slug: 'worker-record-ttl',
    name: '24h worker record TTL',
    watches: 'Age of persisted worker records in the runner-local store, for expiry cleanup',
    threshold:
      'MAX_AGE_MS (24h) since the record\'s last real activity. Fixed in a separate, already-landed change ' +
      '(fix/runner-worker-store-test-isolation): loadAllWorkers used to re-stamp _savedAt to "now" every time ' +
      'it rewrote a working record to error, so a perpetually-rewritten record could never age past the TTL. ' +
      'Not owned by this registry to avoid a two-branch collision on worker-store.ts; tracked here as a named ' +
      'entry so the five-signal audit stays complete.',
    location: 'apps/runner/src/worker-store.ts#loadAllWorkers',
    noLocalFireTest: {
      reason: 'fix already landed on an uncommitted sibling branch that touches the same _savedAt stamping this repair would; merging both independently would conflict',
      trackedBy: 'branch fix/runner-worker-store-test-isolation',
    },
  },
  {
    slug: 'disk-space-alert',
    name: 'Disk-space alert',
    watches: 'Free space on the volume that actually fills on a worker host',
    threshold:
      'Fixed remaining-space percentage (see disk-cleanup.sh in the infrastructure repo). Currently measures ' +
      'the host root filesystem instead of the volume workers actually fill, so it can report healthy while ' +
      'the real volume is full.',
    location: 'disk-cleanup.sh (infrastructure repo, not this codebase)',
    noLocalFireTest: {
      reason: 'implementation lives in the infrastructure repo, not this codebase',
      trackedBy: 'buildd task fa6d9242-de79-43fb-a7f2-e3393f217730 (buildd-ai/infrastructure)',
    },
  },
];
