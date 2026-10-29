/** Development-only queue view for the states a calm clone never reaches. */
import type { HealthQueueResponse } from '@buildd/shared';
import { buildHealthQueueView } from '@/lib/health-queue-view';

export function resolveQueueSample(raw: string | string[] | undefined, env = process.env.NODE_ENV): boolean {
  return env === 'development' && (Array.isArray(raw) ? raw[0] : raw) === 'sample';
}

export function sampleQueueView(now: number): HealthQueueResponse {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const ws = 'sample-workspace';
  const task = (n: number, title: string, wait: Parameters<typeof buildHealthQueueView>[0]['tasks'][number]['wait'], extra: object = {}) =>
    ({ id: `sample-task-${n}`, title, workspaceId: ws, missionTitle: 'Make the queue honest', createdAt: ago(n * 90), wait, ...extra });
  return buildHealthQueueView({
    now,
    // More live runs than slots: the "running, over N slots" tile.
    running: 5,
    slots: 3,
    teamBusy: 5,
    filter: 'all',
    page: 1,
    truncated: false,
    missions: [{ id: 'sample-mission', title: 'Make the queue honest' }],
    tasks: [
      task(1, 'feat: add the status column', { kind: 'declared', blockerId: 'sample-task-9', blockerTitle: 'refactor: split the status table', blockerStatus: 'in_progress', count: 1 }, { setBy: 'Its agent', why: 'Needs the new table first' }),
      task(2, 'chore: rename the audit table', { kind: 'lane', lane: 'migration', position: 1, holderTaskId: 'sample-holder', aheadTaskId: null }),
      task(3, 'fix: backfill the review flags', { kind: 'limit', limit: 'budget', liftsAt: new Date(now + 3 * 3600_000).toISOString(), forceable: true }),
      task(4, 'docs: explain the lane rules', { kind: 'limit', limit: 'plan', liftsAt: null, forceable: false }),
    ],
    lanes: [
      { workspaceId: ws, lane: 'migration', members: [
        { taskId: 'sample-holder', title: 'feat: add the review column', holding: true, status: 'in_progress', prNumber: 1234, since: ago(180), stuckSince: null },
        { taskId: 'sample-task-2', title: 'chore: rename the audit table', holding: false, status: 'pending', prNumber: null, since: ago(120), stuckSince: null },
      ] },
      { workspaceId: ws, lane: 'schema', members: [
        { taskId: 'sample-stuck', title: 'feat: add the lane index', holding: true, status: 'in_progress', prNumber: 1201, since: ago(60 * 40), stuckSince: ago(60 * 30) },
      ] },
    ],
  });
}
