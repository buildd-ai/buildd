'use client';

/**
 * `?state=health-queue`: the whole Health › Queue board (spec 4bc3e70e r8)
 * over a sample view built by the real view builder: tiles, the idle alert,
 * Blocked rows of every reason with their actions, Lanes with each holder's
 * StageMeter, Queued rows in claim order and Scheduled. Reaching this live
 * needs a busy team queue, so a route screenshot never does.
 */
import { buildHealthQueueView, type HealthQueueTaskInput } from '@/lib/health-queue-view';
import type { QueueWait } from '@buildd/shared';
import QueueBoard from '@/app/app/(protected)/health/queue/QueueBoard';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const MIN = 60_000;
const noop = () => {};

const task = (id: string, title: string, missionTitle: string | null, ageMin: number, wait: QueueWait): HealthQueueTaskInput => ({
  id, title, workspaceId: 'ws-1', missionTitle, createdAt: new Date(NOW - ageMin * MIN).toISOString(), wait,
});

const TASKS: HealthQueueTaskInput[] = [
  task('r1', 'Running tile reads Capacity', 'Health', 4, { kind: 'slot', noRunnerReason: null }),
  task('r2', 'Review queue counts', 'Health', 2, { kind: 'slot', noRunnerReason: 'no reviewer runner online' }),
  task('l1', 'Lane holder shows queue position', 'Honest queue', 38, { kind: 'lane', lane: 'migration', position: 2, holderTaskId: 'h1' }),
  task('l2', 'Queue tile links', 'Honest queue', 21, { kind: 'lane', lane: 'migration', position: 3, holderTaskId: 'h1' }),
  task('m1', 'Nightly export cleanup', null, 12, { kind: 'limit', limit: 'mission_cap', forceable: true }),
  task('m2', 'Usage chart for 30 days', 'Health', 7, { kind: 'limit', limit: 'budget', liftsAt: new Date(NOW + 110 * MIN).toISOString(), forceable: false }),
  task('d1', 'Queue settings page', 'Honest queue', 64, { kind: 'declared', blockerId: 'x1', blockerTitle: 'Export job', blockerStatus: 'in_progress', count: 1 }),
  task('d2', 'Export link expiry', null, 58, { kind: 'declared', blockerId: 'x1', blockerTitle: 'Export job', blockerStatus: 'in_progress', count: 1 }),
  task('p1', 'Weekly digest', null, 90, { kind: 'start_time', startAt: new Date(NOW + 125 * MIN).toISOString() }),
];

const VIEW = buildHealthQueueView({
  now: NOW,
  running: 4,
  slots: 6,
  teamBusy: 4,
  tasks: TASKS,
  lanes: [
    { workspaceId: 'ws-1', lane: 'migration', members: [
      { taskId: 'h1', title: 'Queue counts per reason', holding: true, status: 'completed', prNumber: 412, since: new Date(NOW - 50 * MIN).toISOString(), stuckSince: null },
      { taskId: 'l1', title: 'Lane holder shows queue position', holding: false, status: 'pending', prNumber: null, since: null, stuckSince: null },
      { taskId: 'l2', title: 'Queue tile links', holding: false, status: 'pending', prNumber: null, since: null, stuckSince: null },
    ] },
    { workspaceId: 'ws-1', lane: 'surface:billing', members: [
      { taskId: 'h2', title: 'Desired slots column', holding: true, status: 'in_progress', prNumber: null, since: new Date(NOW - 20 * MIN).toISOString(), stuckSince: null },
      { taskId: 'w2', title: 'Slots backfill', holding: false, status: 'pending', prNumber: null, since: null, stuckSince: null },
    ] },
  ],
  filter: 'all',
  page: 1,
  truncated: false,
  missions: [],
});

export default function HealthQueueFixture() {
  return (
    <main data-testid="health-queue-fixture" className="mx-auto min-h-screen max-w-5xl bg-surface-1 px-4 py-6 text-text-primary md:px-10">
      <h1 className="hidden md:block text-heading font-bold mb-4">Queue</h1>
      <QueueBoard view={VIEW} now={NOW} onFilter={noop} onPage={noop} onOpenLane={noop} onStart={noop} />
    </main>
  );
}
