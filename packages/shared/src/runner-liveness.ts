// Poll cadence in minutes — configurable via BUILDD_RUNNER_POLL_MIN (default 60).
// Both the runner and the server read this env var so the liveness window scales
// automatically when the interval is changed without touching code.
export const RUNNER_POLL_MIN = Number(
  process.env.BUILDD_RUNNER_POLL_MIN ?? 60
);

export const RUNNER_HEARTBEAT_INTERVAL_MS = RUNNER_POLL_MIN * 60_000;

// Runner is "online" when its last beat arrived within 1.5× the interval.
// Between 1.5× and 2.5× it shows as "stale" (beat is overdue but runner may recover).
// Beyond 2.5× the interval the record is excluded from queries entirely.
export const RUNNER_ONLINE_THRESHOLD_MS = 1.5 * RUNNER_HEARTBEAT_INTERVAL_MS;
export const RUNNER_STALE_CUTOFF_MS = 2.5 * RUNNER_HEARTBEAT_INTERVAL_MS;
