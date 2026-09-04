/**
 * Pure, dependency-free runner-heartbeat helpers and types.
 *
 * This module MUST NOT import the DB (or anything that transitively pulls in
 * `@buildd/core/db` → `packages/core/config.ts` → `dotenv.config()`), because
 * it is imported by client components (e.g. HealthClient). `dotenv.config()`
 * reads `process.stdout.isTTY`, which is undefined in the browser and throws
 * `Cannot read properties of undefined (reading 'isTTY')` during module
 * evaluation — taking down the whole client bundle and every page that ships
 * it. Keep DB access in `runner-heartbeats.ts`.
 */

export interface RunnerHeartbeat {
  id: string;
  accountId: string;
  accountName: string | null;
  lastHeartbeatAt: string;
  activeWorkerCount: number;
  maxConcurrentWorkers: number;
  /** How the runner connects: push_only = no inbound HTTP (headless/NAT), reachable = has inbound HTTP server. */
  connectivity: 'reachable' | 'push_only';
  /**
   * Whether the host's bwrap namespace probe passed. null = probe not yet run.
   * This is a CAPABILITY, not a posture: true means bwrap works here, not that
   * anything is confined. See deriveSandboxPosture.
   */
  sandboxEnabled: boolean | null;
  /** ISO timestamp of the last bwrap probe, or null if not yet probed. */
  sandboxProbeAt: string | null;
  /**
   * Whether the runner reports the `sandbox:mount-allowlist` capability, i.e. the
   * mount allowlist is opted in AND the namespace it needs is available. This is
   * the only signal that isolation is actually being enforced.
   */
  mountAllowlistEnforced: boolean;
}

/** Capability string the runner advertises when mount isolation is enforced. */
const CAPABILITY_MOUNT_ALLOWLIST = 'sandbox:mount-allowlist';

/**
 * Read the mount-allowlist capability out of a heartbeat's reported environment.
 *
 * The capability has existed in the heartbeat payload since the mount-allowlist
 * rollout and had no reader here, which is why the page could only show kernel
 * capability. Duplicated as a literal rather than imported from @buildd/shared
 * because this module is bundled into a client component and must stay
 * dependency-free (see the file header).
 */
export function mountAllowlistEnforcedFrom(
  environment: { envKeys?: string[] } | null | undefined,
): boolean {
  return Boolean(environment?.envKeys?.includes(CAPABILITY_MOUNT_ALLOWLIST));
}

export interface SandboxPosture {
  label: string;
  tier: 'success' | 'warning' | 'unknown';
  /** One-line explanation for the badge tooltip / problems list. */
  detail: string;
}

/**
 * What the Health page should say about a runner's sandbox.
 *
 * Green means enforced — bwrap works AND the mount allowlist is on. A host with
 * bwrap installed but the allowlist off is the worst case for a green badge: it
 * looks confined and is not, so it reports as a warning instead.
 */
export function deriveSandboxPosture(hb: {
  sandboxEnabled: boolean | null;
  mountAllowlistEnforced: boolean;
}): SandboxPosture {
  if (hb.sandboxEnabled === null) {
    return {
      label: 'sandbox unknown',
      tier: 'unknown',
      detail: 'no bwrap probe reported yet',
    };
  }
  if (hb.sandboxEnabled === false) {
    return {
      label: 'unsandboxed',
      tier: 'warning',
      detail: 'user namespaces denied · tasks run without bwrap isolation',
    };
  }
  if (!hb.mountAllowlistEnforced) {
    return {
      label: 'mounts unrestricted',
      tier: 'warning',
      detail: 'bwrap available but the mount allowlist is off · the agent sees the whole host filesystem',
    };
  }
  return {
    label: 'sandboxed',
    tier: 'success',
    detail: 'bwrap namespace + mount allowlist enforced',
  };
}

// 3× the 60-second liveness ping interval — absorbs transient network hiccups.
export const RUNNER_ONLINE_WINDOW_MS = 3 * 60 * 1000;

/**
 * Runner is "online" when its last liveness beat arrived within the past 3
 * minutes of `now`.
 *
 * `now` is a required parameter, never `Date.now()` internally: a runner
 * sitting near the threshold flips this boolean depending on exactly when
 * it's evaluated, and this function used to read the clock itself, so a
 * render-time call from a SSR-ed client component (HealthClient) could
 * disagree between the server render and the client hydration render a few
 * hundred milliseconds later. Callers that render must pass a single
 * pinned `now`; only genuinely client-only, event-driven call sites (e.g. a
 * button-click handler) should pass a fresh `Date.now()`.
 */
export function isRunnerOnline(lastHeartbeatAt: string | Date, now: number): boolean {
  return now - new Date(lastHeartbeatAt).getTime() < RUNNER_ONLINE_WINDOW_MS;
}

/**
 * Headless runners use a `headless://hostname` sentinel for localUiUrl instead of
 * a real HTTP URL. They have no inbound HTTP server — heartbeats flow outbound only.
 */
export function isPushOnlyRunner(localUiUrl: string): boolean {
  return localUiUrl.startsWith('headless://');
}

export interface RunnerRelevanceCandidate {
  accountId: string;
  accountTeamId: string | null;
}

/**
 * Decide which heartbeating accounts belong on a team's Health page.
 * Relevant when the account is in the team, explicitly linked to one of the
 * scoped workspaces, or has actually run workers in one. Mere claim
 * *eligibility* is not enough — open-access workspaces are claimable by any
 * account on the platform, and strangers' runners must not appear here.
 */
export function selectRelevantRunnerAccounts(
  candidates: RunnerRelevanceCandidate[],
  opts: {
    teamId: string;
    linkedAccountIds: ReadonlySet<string>;
    workedAccountIds: ReadonlySet<string>;
  },
): Set<string> {
  const relevant = new Set<string>();
  for (const c of candidates) {
    if (
      c.accountTeamId === opts.teamId ||
      opts.linkedAccountIds.has(c.accountId) ||
      opts.workedAccountIds.has(c.accountId)
    ) {
      relevant.add(c.accountId);
    }
  }
  return relevant;
}
