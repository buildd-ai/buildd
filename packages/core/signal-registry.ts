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
      "e.g. 'sonnet') and never against ModelInfo.resolvedModel (the fully-qualified wire id) that " +
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
    slug: 'ci-fix-bot-actor-allowlist',
    name: 'CI auto-fix bot-actor allowlist',
    watches: 'Whether the claude-code-action repair step is allowed to run when the dev push it is reacting to was authored by a known repo bot (buildd-ai worker commits, buildd-release)',
    threshold:
      "allowed_bots names both bots this workflow's trigger can ever produce, never '*'. Previously the " +
      "default empty allowlist rejected every bot-authored push outright ('Workflow initiated by " +
      "non-human actor... Add bot to allowed_bots list') — a large share of ci-fix.yml failures, all " +
      'landing at the claude-code-action step.',
    location: '.github/workflows/ci-fix.yml (auto-fix job, claude-code-action step)',
    fireTest: {
      file: 'scripts/ci-repair-workflows.test.ts',
      title: 'allows the two bots this workflow can ever be triggered by, and nothing wider',
    },
  },
  {
    slug: 'ci-fix-max-turns-headroom',
    name: 'CI auto-fix turn budget',
    watches: "The claude-code-action repair step's --max-turns budget against what a working fix has actually needed",
    threshold:
      '--max-turns >= 50. Successful repair runs were finishing just under the previous 30-turn cap — ' +
      'already close to binding on a WORKING fix — while a large share of failures hit the cap outright ' +
      '(Claude execution failed: Reached maximum number of turns).',
    location: '.github/workflows/ci-fix.yml (auto-fix job, claude-code-action step claude_args)',
    fireTest: {
      file: 'scripts/ci-repair-workflows.test.ts',
      title: 'gives the fix agent headroom above what a working run has actually needed',
    },
  },
  {
    slug: 'disk-space-alert',
    name: 'Disk-space alert',
    watches: 'Free space on the volume that actually fills on a worker host',
    threshold:
      'Fixed remaining-space percentage (see disk-cleanup.sh in the infrastructure repo). Fixed to resolve ' +
      'the volume Docker actually stores data on at runtime (via `docker info`), instead of the host root ' +
      'filesystem, so it can no longer report healthy while the real volume is full.',
    location: 'disk-cleanup.sh (infrastructure repo, not this codebase)',
    noLocalFireTest: {
      reason: 'implementation lives in the infrastructure repo, not this codebase',
      trackedBy: 'buildd-ai/infrastructure repo: scripts/disk-cleanup.sh (docker_root_dir) + scripts/disk-cleanup.test.sh (fire-test, wired into that repo\'s CI)',
    },
  },
];

/**
 * `withCronRun` (apps/web/src/lib/cron-run.ts) records every scheduled job's
 * `changed` count and pages when a job's recent runs trend unhealthy. That
 * trend logic (`evaluateCronHealth`, apps/web/src/lib/cron-health.ts) reads
 * `changed` as "work landed" — nonzero is evidence of health.
 *
 * That reading is backwards for a DETECTOR job, where `changed` counts
 * problems FOUND, not work performed. A detector finding a real, ongoing
 * outage every single run reports the same nonzero `changed` a maximally
 * healthy worker sweep would — and reads healthier the worse the outage gets.
 * An outage ran a full night on exactly this blind spot: the detector was
 * right on every run and the supervisor watching it had no way to tell "still
 * finding the same fire" from "still doing useful work".
 *
 * This registry names each job's polarity explicitly so `evaluateCronHealth`
 * never has to infer it from the result shape — inference silently
 * misclassifies the next job someone adds. A job not listed here defaults to
 * `'work'`, which is `evaluateCronHealth`'s original behaviour, so adding this
 * registry changes nothing until a job opts in.
 */
export type CronChangedPolarity = 'work' | 'findings';

/**
 * The exact marker a notify-test must carry, immediately above the `it`/`test`
 * block that proves a `findings`-polarity job actually notifies a human when
 * it reports something. Same convention as SIGNAL_FIRE_MARKER_PREFIX, kept as
 * a separate constant because it proves a different claim: not "this signal
 * can trip", but "tripping this signal reaches a human", which is the exact
 * gap that let a fleet-idle alarm go unnoticed for a full night despite firing
 * correctly on every run.
 */
export const NOTIFY_FIRE_MARKER_PREFIX = '@notify-fire:';

/** Build the exact marker comment text for a slug, e.g. `@notify-fire: foo`. */
export function formatNotifyFireMarker(slug: string): string {
  return `${NOTIFY_FIRE_MARKER_PREFIX} ${slug}`;
}

/** The marker-matching pattern. See signalFireMarkerPattern for why the slug is kebab-restricted. */
export function notifyFireMarkerPattern(): RegExp {
  const escaped = NOTIFY_FIRE_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}[ \\t]*([a-z0-9]+(?:-[a-z0-9]+)*)`, 'g');
}

/** Extract every slug referenced by a notify-fire marker comment in `source`, in order. */
export function parseNotifyFireMarkers(source: string): string[] {
  return [...source.matchAll(notifyFireMarkerPattern())].map(m => m[1]);
}

export interface CronJobRegistryEntry {
  /**
   * Unique kebab-case identifier, referenced by the notify-fire marker
   * comment. Distinct from `job` because a `withCronRun` job slug can contain
   * `:` for a route with more than one cadence (e.g. `queue-stall:fleet-idle`),
   * which the marker's kebab-case pattern deliberately cannot match.
   */
  slug: string;
  /** The exact `job` string passed to `withCronRun`. */
  job: string;
  name: string;
  changedPolarity: CronChangedPolarity;
  /** One line: what `changed` counts for this job, since the meaning differs by polarity. */
  changedMeaning: string;
  /**
   * Required for `changedPolarity: 'findings'` — proof this job has a real,
   * demonstrated path to notify a human when it finds something. A
   * `findings` job with no notification path can raise an internal alarm
   * that nobody ever sees, which is precisely the failure this registry
   * exists to make impossible to ship silently.
   */
  notifyTest?: { file: string; title: string };
}

export const CRON_JOB_REGISTRY: CronJobRegistryEntry[] = [
  {
    slug: 'queue-stall-gate-ladder',
    job: 'queue-stall',
    name: 'Queue-stall per-task gate ladder',
    changedPolarity: 'findings',
    changedMeaning: 'stalled tasks found and notified this run, not work performed',
    notifyTest: {
      file: 'apps/web/src/app/api/cron/queue-stall/route.test.ts',
      title: 'sends one Pushover alert that names the gate, and stamps the task',
    },
  },
  {
    slug: 'queue-stall-fleet-idle',
    job: 'queue-stall:fleet-idle',
    name: 'Queue-stall fleet-idle detector',
    changedPolarity: 'findings',
    changedMeaning: 'accounts found alive-but-claiming-nothing and alerted this run',
    notifyTest: {
      file: 'apps/web/src/app/api/cron/queue-stall/route.test.ts',
      title: 'alarms when a heartbeating fleet has claimable work and has started nothing',
    },
  },
];

/** A job's declared polarity, or `'work'` (evaluateCronHealth's original behaviour) if unregistered. */
export function getCronJobPolarity(job: string): CronChangedPolarity {
  return CRON_JOB_REGISTRY.find(e => e.job === job)?.changedPolarity ?? 'work';
}
