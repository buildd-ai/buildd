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
}

/** Runner is "online" when its last beat is within the past 2 minutes. */
export function isRunnerOnline(lastHeartbeatAt: string | Date): boolean {
  return Date.now() - new Date(lastHeartbeatAt).getTime() < 2 * 60 * 1000;
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
