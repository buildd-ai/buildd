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

// ─── "Is this runner up?" windows ───────────────────────────────────────────
//
// A runner writes `worker_heartbeats.last_heartbeat_at` on two timers: the 60s
// liveness ping (LIVENESS_PING_INTERVAL_MS) and the poll cycle
// (RUNNER_HEARTBEAT_INTERVAL_MS). "How recent must the last beat be" has a
// different right answer depending on what the caller does with a wrong
// answer, so there are several windows — but every one of them is named here
// and derived from the cadence that makes it true. Do not hand-type a window
// at a call site; pick the question below.
//
//   RUNNER_LIVE_WINDOW_MS      "online NOW"      presence UI, "browser runner
//                                                available", steer presence.
//   RUNNER_RECENTLY_SEEN_MS    "demonstrably up" alarms that must only fire
//                                                against a runner that is up,
//                                                pickup-likelihood feedback.
//   RUNNER_ONLINE_THRESHOLD_MS "online" at poll  runner lists / fleet capacity.
//                              cadence
//   RUNNER_STALE_CUTOFF_MS     "NOT DEAD"        the only window allowed to
//                                                fail workers or delete rows.
//
// Anything destructive keys off RUNNER_STALE_CUTOFF_MS: being wrong there kills
// in-flight work, so it tolerates a runner build that only beats on the poll
// cycle dropping a beat. Using a presence window to kill workers is the bug
// that failed live workers from a 10-minute cutoff (task 5c0ea9bc).

/** "Online now": last liveness ping within 3 pings. A wrong answer only mislabels a dot. */
export const RUNNER_LIVE_WINDOW_MS = 3 * LIVENESS_PING_INTERVAL_MS;

/** "Demonstrably up": last liveness ping within 10 pings. Gates alarms that presume a live runner. */
export const RUNNER_RECENTLY_SEEN_MS = 10 * LIVENESS_PING_INTERVAL_MS;

// Runner is "online" when its last beat arrived within 1.5× the poll interval.
// Between 1.5× and 2.5× it shows as "stale" (beat is overdue but runner may recover).
// Beyond 2.5× the interval the runner is presumed dead: the record is excluded
// from queries, its heartbeat row may be deleted, and — only if NO runner on the
// account is inside this window — its workers are failed.
export const RUNNER_ONLINE_THRESHOLD_MS = 1.5 * RUNNER_HEARTBEAT_INTERVAL_MS;
export const RUNNER_STALE_CUTOFF_MS = 2.5 * RUNNER_HEARTBEAT_INTERVAL_MS;

// ─── Interactive (MCP-claimed) workers ──────────────────────────────────────
//
// `claim_task` from an MCP session mints a worker with `runner = 'mcp'`: a
// person's own Claude Code session (or its local agents) does the work, and no
// runner process ever starts a session for the row. So none of the runner
// liveness signals above apply to it. `started_at` stays NULL until the first
// `update_progress`, tokens and turns are never synced, and there is no runner
// heartbeat. Judged by the runner rules it reads as "never started" after five
// idle minutes, which reaped live interactive work and re-queued it for a
// runner to duplicate (friction 92866723).
//
// Instead an interactive worker is alive while its account keeps making MCP
// calls (each call bumps `workers.updated_at`, see
// apps/web/src/lib/interactive-worker-liveness.ts), and is reaped only after
// this long with no MCP activity at all, so an abandoned claim still frees up.

/** `workers.runner` value for a worker minted by an MCP `claim_task`. */
export const INTERACTIVE_WORKER_RUNNER = 'mcp';

/** Reap an interactive worker only after this long without any MCP activity. */
export const INTERACTIVE_WORKER_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
