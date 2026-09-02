// Poll cadence in minutes — configurable via BUILDD_RUNNER_POLL_MIN (default 60).
// Both the runner and the server read this env var so the liveness window scales
// automatically when the interval is changed without touching code.
export const RUNNER_POLL_MIN = Number(
  process.env.BUILDD_RUNNER_POLL_MIN ?? 60
);

// Task-poll cycle: reconcile, claim fallback, and knowledge ingest all fire here.
// This is NOT the liveness ping — it's the task-coordination heartbeat.
export const RUNNER_HEARTBEAT_INTERVAL_MS = RUNNER_POLL_MIN * 60_000;

// Liveness ping interval: a pure "runner is alive" signal sent every 60s,
// independent of task activity. isRunnerOnline on the Health tab keys off this.
export const LIVENESS_PING_INTERVAL_MS = 60_000;

// The runner's own backstop: no worker session may sit without SDK activity
// longer than this before the runner aborts it locally (worker-sync.ts
// checkStale). The runner deliberately suppresses its shorter adaptive stale
// probe while a tool call is in flight, because long silent tools (a bash
// waiting on CI, a full test suite) emit no SDK stream messages — so this is the
// only ceiling a legitimately busy worker is subject to.
export const WORKER_HARD_TIMEOUT_MS = 30 * 60 * 1000;

// How long the server waits *after* the runner's backstop before reaping the
// worker row itself. The runner aborts at WORKER_HARD_TIMEOUT_MS and reports a
// specific error; without this grace the server's generic "stale worker
// expired" would overwrite that real cause.
export const WORKER_STALE_REAP_GRACE_MS = 5 * 60 * 1000;

// Server-side reap threshold for running/starting workers.
//
// MUST stay strictly above WORKER_HARD_TIMEOUT_MS. This previously sat at 15
// minutes while the runner tolerated 30, and since `workers.updatedAt` only
// advances when the runner syncs a *state change*, any silent tool call between
// the two thresholds was a guaranteed false-positive kill of a healthy session.
// Derived rather than hand-tuned so the two cannot drift apart again; the
// invariant is asserted in packages/core/__tests__/worker-stale-thresholds.test.ts.
//
// Orphan reclamation (runner process gone) is owned by the separate
// runner-heartbeat rule in stale-workers.ts, not by this threshold.
export const WORKER_STALE_REAP_MS = WORKER_HARD_TIMEOUT_MS + WORKER_STALE_REAP_GRACE_MS;

// ─── Worker liveness leases ─────────────────────────────────────────────────
//
// The lease replaces INFERRED liveness with ASSERTED liveness. Everything above
// derives from `workers.updatedAt`, which only advances as a side effect of the
// runner syncing a state CHANGE — so a worker busy inside one long silent tool
// call and a worker whose process died produce identical evidence (silence), and
// any threshold is therefore simultaneously too short and too long.
//
// A lease is renewed by the runner's liveness TIMER (deterministic code, never
// the agent loop), so it keeps ticking through a 20-minute silent tool call.
// That decouples "is this worker alive" from "is this agent emitting messages"
// and lets the reap window get much TIGHTER instead of looser.

/**
 * Lease lifetime granted on each renewal. Renewal rides the existing
 * LIVENESS_PING_INTERVAL_MS (60s) heartbeat, so this tolerates 4 consecutive
 * missed beats — enough for a Neon cold start or a brief network blip.
 */
export const WORKER_LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * Renewal cadence. Deliberately the same timer as the runner liveness ping so
 * there is exactly one "I am alive" signal, now carrying worker identity rather
 * than only a scalar count (the gap that left the server unable to tell WHICH
 * of a live runner's workers a fresh heartbeat vouched for).
 */
export const WORKER_LEASE_RENEW_INTERVAL_MS = LIVENESS_PING_INTERVAL_MS;

/**
 * Renewals that may be missed before a lease lapses. Asserted in tests: a TTL at
 * or below the renew interval would expire healthy workers between beats.
 */
export const WORKER_LEASE_MISSED_BEATS_TOLERATED = Math.floor(
  WORKER_LEASE_TTL_MS / WORKER_LEASE_RENEW_INTERVAL_MS,
) - 1;

// Runner is "online" when its last beat arrived within 1.5× the interval.
// Between 1.5× and 2.5× it shows as "stale" (beat is overdue but runner may recover).
// Beyond 2.5× the interval the record is excluded from queries entirely.
export const RUNNER_ONLINE_THRESHOLD_MS = 1.5 * RUNNER_HEARTBEAT_INTERVAL_MS;
export const RUNNER_STALE_CUTOFF_MS = 2.5 * RUNNER_HEARTBEAT_INTERVAL_MS;
