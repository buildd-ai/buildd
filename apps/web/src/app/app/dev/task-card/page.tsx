'use client';

import { TaskCard } from '@/components/TaskCard';
import { deriveChainPosition, deriveIntensity } from '@/lib/task-presentation';

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const min = 60_000;
const hr = 60 * min;

// ─── Shared fixture data ───────────────────────────────────────────────────

const TASK_RUNNING = {
  id: 'task-001',
  title: 'Build the TaskCard component consuming lib/task-presentation.ts',
  taskStatus: 'assigned',
  workerStatus: 'running' as const,
  missionId: 'mission-abc',
  missionTitle: 'Information Hierarchy Mission',
  workspaceName: 'buildd',
  taskCreatedAt: ago(2 * hr),
  taskUpdatedAt: ago(3 * min),
  workerStartedAt: ago(90 * min),
  workerUpdatedAt: ago(3 * min),
  intensity: deriveIntensity({
    turns: [
      NOW - 80 * min, NOW - 75 * min, NOW - 70 * min,
      NOW - 60 * min, NOW - 55 * min, NOW - 50 * min, NOW - 45 * min,
      NOW - 30 * min, NOW - 25 * min,
      NOW - 10 * min, NOW - 5 * min, NOW - 2 * min,
    ],
    startedAt: ago(90 * min),
    workerUpdatedAt: ago(3 * min),
    now: NOW,
  }),
  runnerName: 'coder-workspace-f1fc4699',
  prUrl: null,
  prNumber: null,
};

const TASK_WITH_CHAIN_FULL = {
  ...TASK_RUNNING,
  chain: deriveChainPosition({
    task: { id: 'task-001', status: 'assigned' },
    deps: [
      {
        id: 'dep-1',
        title: 'Extend task-presentation.ts with deriveChainPosition',
        status: 'completed',
        workers: [{ prUrl: 'https://github.com/buildd-ai/buildd/pull/1265', prNumber: 1265, mergedAt: '2025-07-10T12:00:00Z' }],
      },
      {
        id: 'dep-2',
        title: 'Add deriveIntensity and LIVE_WORKER_STATUSES',
        status: 'completed',
        workers: [{ prUrl: 'https://github.com/buildd-ai/buildd/pull/1266', prNumber: 1266, mergedAt: null }],
      },
    ],
    dependents: 2,
  }),
};

const TASK_COMPLETED = {
  id: 'task-002',
  title: 'Extend lib/task-presentation.ts with deriveChainPosition',
  taskStatus: 'completed',
  workerStatus: null as null,
  missionId: 'mission-abc',
  missionTitle: 'Information Hierarchy Mission',
  workspaceName: 'buildd',
  taskCreatedAt: ago(5 * hr),
  taskUpdatedAt: ago(1 * hr),
  workerStartedAt: ago(3 * hr),
  workerUpdatedAt: ago(1 * hr),
  intensity: null,
  runnerName: 'coder-workspace-a1b2c3',
  prUrl: 'https://github.com/buildd-ai/buildd/pull/1265',
  prNumber: 1265,
  chain: deriveChainPosition({
    task: { id: 'task-002', status: 'completed' },
    deps: [
      {
        id: 'dep-0',
        title: 'Design: task-presentation.md',
        status: 'completed',
        workers: [{ prUrl: null, mergedAt: null }],
      },
    ],
    dependents: 3,
  }),
};

const TASK_HALF_BLOCKED = {
  id: 'task-003',
  title: 'Mount TaskCard into mission timeline surface',
  taskStatus: 'pending',
  workerStatus: null as null,
  missionId: 'mission-abc',
  missionTitle: 'Information Hierarchy Mission',
  workspaceName: 'buildd',
  taskCreatedAt: ago(30 * min),
  taskUpdatedAt: ago(30 * min),
  workerStartedAt: null,
  workerUpdatedAt: null,
  intensity: null,
  runnerName: null,
  prUrl: null,
  prNumber: null,
  chain: deriveChainPosition({
    task: { id: 'task-003', status: 'pending' },
    deps: [
      {
        id: 'dep-2',
        title: 'TaskCard component (this task)',
        status: 'completed',
        workers: [{ prUrl: 'https://github.com/buildd-ai/buildd/pull/1300', prNumber: 1300, mergedAt: null }],
      },
    ],
    dependents: 0,
  }),
};

const TASK_STALLED = {
  id: 'task-004',
  title: 'Fix CI retry logic for failed integration tests',
  taskStatus: 'assigned',
  workerStatus: 'running' as const,
  missionId: null,
  missionTitle: null,
  workspaceName: 'buildd',
  taskCreatedAt: ago(3 * hr),
  taskUpdatedAt: ago(90 * min),
  workerStartedAt: ago(2 * hr),
  workerUpdatedAt: ago(90 * min),
  intensity: deriveIntensity({
    turns: [NOW - 2 * hr, NOW - 115 * min, NOW - 110 * min],
    startedAt: ago(2 * hr),
    workerUpdatedAt: ago(90 * min),
    now: NOW,
  }),
  runnerName: 'coder-workspace-z9y8x7',
  prUrl: null,
  prNumber: null,
  chain: null,
  attemptCurrent: 3,
  attemptTotal: 4,
};

const TASK_WAITING = {
  id: 'task-005',
  title: 'Implement OAuth credential refresh with rotation lock',
  taskStatus: 'assigned',
  workerStatus: 'waiting_input' as const,
  missionId: 'mission-xyz',
  missionTitle: 'Auth Hardening',
  workspaceName: 'buildd',
  taskCreatedAt: ago(4 * hr),
  taskUpdatedAt: ago(15 * min),
  workerStartedAt: ago(3 * hr),
  workerUpdatedAt: ago(15 * min),
  intensity: deriveIntensity({
    turns: [NOW - 3 * hr, NOW - 2.5 * hr, NOW - 2 * hr, NOW - 90 * min, NOW - 30 * min],
    startedAt: ago(3 * hr),
    workerUpdatedAt: ago(15 * min),
    now: NOW,
  }),
  runnerName: 'coder-workspace-m4n5o6',
  prUrl: null,
  prNumber: null,
  chain: deriveChainPosition({
    task: { id: 'task-005', status: 'assigned' },
    deps: [
      { id: 'dep-a', title: 'Secrets table migration', status: 'completed', workers: [{ prUrl: null, mergedAt: null }] },
      { id: 'dep-b', title: 'OAuth endpoint scaffolding', status: 'completed', workers: [{ prUrl: 'https://github.com/buildd-ai/buildd/pull/1258', prNumber: 1258, mergedAt: '2025-07-08T00:00:00Z' }] },
    ],
    dependents: 1,
  }),
};

const TASK_STANDALONE = {
  id: 'task-006',
  title: 'Update CHANGELOG.md for v0.138.2',
  taskStatus: 'completed',
  workerStatus: null as null,
  missionId: null,
  missionTitle: null,
  workspaceName: 'buildd',
  taskCreatedAt: ago(6 * hr),
  taskUpdatedAt: ago(5 * hr),
  workerStartedAt: ago(5.5 * hr),
  workerUpdatedAt: ago(5 * hr),
  intensity: null,
  runnerName: 'coder-workspace-p1q2r3',
  prUrl: 'https://github.com/buildd-ai/buildd/pull/1297',
  prNumber: 1297,
  chain: null,
};

// ─── Fixture page ─────────────────────────────────────────────────────────────

export default function TaskCardFixturePage() {
  return (
    <div className="min-h-screen bg-surface-1 p-8">
      <div className="max-w-3xl mx-auto space-y-12">
        <div>
          <h1 className="text-xl font-bold text-text-primary mb-1">TaskCard — dev fixtures</h1>
          <p className="text-[12px] text-text-secondary font-mono">
            Three densities · all states · no database
          </p>
        </div>

        {/* ── FULL density ─────────────────────────────────────────────────── */}
        <section>
          <div className="section-label mb-4">full — Home / Right Now</div>
          <div className="space-y-2">
            <TaskCard {...TASK_WITH_CHAIN_FULL} density="full" />

            <TaskCard
              {...TASK_STALLED}
              density="full"
            />

            <TaskCard
              {...TASK_WAITING}
              density="full"
            />

            <TaskCard
              {...TASK_COMPLETED}
              density="full"
            />

            <TaskCard
              {...TASK_HALF_BLOCKED}
              density="full"
            />

            <TaskCard
              {...TASK_STANDALONE}
              density="full"
            />
          </div>
        </section>

        {/* ── ROW density ──────────────────────────────────────────────────── */}
        <section>
          <div className="section-label mb-4">row — Activity list</div>
          <div className="card">
            <TaskCard {...TASK_WITH_CHAIN_FULL} density="row" />
            <TaskCard {...TASK_WAITING} density="row" />
            <TaskCard {...TASK_STALLED} density="row" />
            <TaskCard {...TASK_COMPLETED} density="row" />
            <TaskCard {...TASK_HALF_BLOCKED} density="row" />
            <TaskCard {...TASK_STANDALONE} density="row" />
          </div>
        </section>

        {/* ── INLINE density ───────────────────────────────────────────────── */}
        <section>
          <div className="section-label mb-4">inline — Mission timeline</div>
          <div className="card divide-y divide-border-default">
            <div className="px-3">
              <TaskCard {...TASK_WITH_CHAIN_FULL} density="inline" />
            </div>
            <div className="px-3">
              <TaskCard {...TASK_WAITING} density="inline" />
            </div>
            <div className="px-3">
              <TaskCard {...TASK_STALLED} density="inline" />
            </div>
            <div className="px-3">
              <TaskCard {...TASK_COMPLETED} density="inline" />
            </div>
            <div className="px-3">
              <TaskCard {...TASK_HALF_BLOCKED} density="inline" />
            </div>
            <div className="px-3">
              <TaskCard {...TASK_STANDALONE} density="inline" />
            </div>
          </div>
        </section>

        {/* ── Chain strip states close-up ──────────────────────────────────── */}
        <section>
          <div className="section-label mb-4">chain strip — segment states</div>
          <p className="text-[11px] text-text-muted mb-3 font-mono">
            filled=merged · half=open-PR (silent blocker) · outlined=current · faint=pending
          </p>
          <div className="space-y-1">
            <TaskCard
              id="chain-demo-1"
              title="Pending — upstream PR still open (half state blocks gate)"
              taskStatus="pending"
              workerStatus={null}
              taskCreatedAt={ago(20 * min)}
              taskUpdatedAt={ago(20 * min)}
              intensity={null}
              runnerName={null}
              chain={deriveChainPosition({
                task: { id: 'chain-demo-1', status: 'pending' },
                deps: [
                  { id: 'a', title: 'A', status: 'completed', workers: [{ prUrl: 'url', mergedAt: '2025-01-01T00:00:00Z' }] },
                  { id: 'b', title: 'B', status: 'completed', workers: [{ prUrl: 'url', prNumber: 1234, mergedAt: null }] },
                  { id: 'c', title: 'C', status: 'pending', workers: [] },
                ],
                dependents: 2,
              })}
              density="full"
            />
          </div>
        </section>
      </div>
    </div>
  );
}
