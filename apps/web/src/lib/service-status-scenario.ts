/**
 * The screenshot scenario for team service status, as signals: one runner's
 * subscription sign-in expired with five tasks waiting, a failure-rate alert
 * and a failed sentinel task about the same runner, and (separately) a true
 * platform outage. Shared by the verification test so the story is defined once.
 */
import type { RawFailureSignals, ServiceStatusViewer } from './service-status';

export const SCENARIO_AT = '2026-10-11T08:00:00.000Z';
export const OWNER = 'user-owner';
export const ADMIN = 'user-admin';
export const MEMBER = 'user-member';
export const OPERATOR_ADMIN = 'user-operator-admin';

const tasks = (workspaceId: string, requesters: string[]) =>
  requesters.map((requesterUserId, i) => ({ taskId: `task-${workspaceId}-${i + 1}`, title: `Task ${i + 1}`, workspaceId, requesterUserId, hasLiveRun: false }));

export function expiredSignInScenario(teamId = 'team-a'): RawFailureSignals {
  return {
    teamId,
    alternateRunnerAvailable: true,
    expiredRunnerOauth: [{
      runnerId: `${teamId}-runner-1`, runnerName: 'Runner A', provider: 'Claude', ownerUserId: OWNER,
      reconnectHref: `/app/settings/runners/${teamId}-runner-1`,
      work: tasks('ws-1', [MEMBER, OWNER, 'user-other', 'user-other', ADMIN]), seenAt: SCENARIO_AT,
    }],
    failureRateAlert: { runnerId: `${teamId}-runner-1`, rate: 0.62, baseline: 0.05, seenAt: SCENARIO_AT },
    sentinelTasks: [{ taskId: 'sentinel-1', title: 'Fix failing pattern', runnerId: `${teamId}-runner-1`, seenAt: SCENARIO_AT }],
  };
}

export function platformOutageScenario(teamId = 'team-a'): RawFailureSignals {
  return {
    teamId, expiredRunnerOauth: [], widespread: true,
    platformManaged: [{ key: 'task-starts', label: 'Task starts', work: tasks('ws-1', [MEMBER, OWNER, ADMIN]), seenAt: SCENARIO_AT }],
  };
}

export const viewerFor = (userId: string, o: Partial<ServiceStatusViewer> = {}, teamId = 'team-a'): ServiceStatusViewer =>
  ({ userId, teamId, isTeamAdmin: false, usableRunnerIds: [], ...o });
