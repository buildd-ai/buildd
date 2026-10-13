/**
 * Loader facts for the service-status tests: one team, its people, one runner
 * and the tasks a root cause hit. Shared by the ownership and loader tests so
 * each section 8 row is set up the same way.
 */
import type { RootCauseClassification, RootCauseRecord } from '@buildd/shared';
import type { ServiceStatusFacts, StatusRunner, StatusTask } from './service-status-loader';

export const TEAM = 'team-a';
export const OWNER = 'user-owner';
export const ADMIN = 'user-admin';
export const MEMBER = 'user-member';
export const LEFT = 'user-left-team';
export const RUNNER = 'runner-1';
export const AT = '2026-10-12T08:00:00.000Z';

export const runner = (o: Partial<StatusRunner> = {}): StatusRunner => ({
  id: RUNNER, name: 'Runner A', authType: 'oauth', managedRunner: false, hostRunner: false,
  createdByUserId: OWNER, recentlyActive: true, ...o,
});

export const task = (id: string, createdByUserId: string | null, o: Partial<StatusTask> = {}): StatusTask => ({
  id, title: `Task ${id}`, workspaceId: 'ws-1', status: 'failed', createdByUserId, hasLiveRun: false, ...o,
});

export const runnerRecord = (classification: RootCauseClassification, taskIds: string[], o: Partial<RootCauseRecord> = {}): RootCauseRecord => ({
  key: `credential:${RUNNER}:claude`, teamId: TEAM,
  capability: { kind: 'runner', runnerId: RUNNER, provider: 'claude', component: null, workspaceId: null },
  classification, affectedTaskIds: taskIds, firstSeenAt: AT, lastSeenAt: AT, verifiedRestoredAt: null, ...o,
});

export const patternRecord = (rule: string, classification: RootCauseClassification, taskIds: string[]): RootCauseRecord => ({
  key: `pattern:${rule}:ws-1`, teamId: TEAM,
  capability: { kind: 'platform', runnerId: null, provider: null, component: rule, workspaceId: 'ws-1' },
  classification, affectedTaskIds: taskIds, firstSeenAt: AT, lastSeenAt: AT, verifiedRestoredAt: null,
});

export function facts(o: Partial<ServiceStatusFacts> = {}): ServiceStatusFacts {
  return {
    teamId: TEAM,
    records: [runnerRecord('credential_expired', ['t1', 't2', 't3'])],
    // A second runner in use, so one broken runner is not "most of the team's work".
    runners: [runner(), runner({ id: 'runner-2', name: 'Runner B', createdByUserId: ADMIN })],
    members: [{ userId: OWNER, role: 'member' }, { userId: ADMIN, role: 'admin' }, { userId: MEMBER, role: 'member' }],
    tasks: [task('t1', MEMBER), task('t2', OWNER), task('t3', ADMIN)],
    teamHasProviderKey: false,
    teamHasSavedSignIn: false,
    recentTaskCount: 20,
    ...o,
  };
}
