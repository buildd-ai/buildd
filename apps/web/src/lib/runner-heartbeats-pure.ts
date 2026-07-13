export interface RunnerHeartbeat {
  id: string;
  accountId: string;
  accountName: string | null;
  lastHeartbeatAt: string;
  activeWorkerCount: number;
  maxConcurrentWorkers: number;
}

/** Runner is "online" when its last beat is within the past 2 minutes. */
export function isRunnerOnline(lastHeartbeatAt: string | Date): boolean {
  return Date.now() - new Date(lastHeartbeatAt).getTime() < 2 * 60 * 1000;
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
