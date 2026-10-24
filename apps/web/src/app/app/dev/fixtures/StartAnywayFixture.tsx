'use client';

/**
 * `?state=start-anyway`: a pending task held only by a declared prerequisite, in
 * the states spec 36df686b R-1 / R-12 / AC-16 describe, rendered through the real
 * `TaskActionZone`: Start anyway offered, its confirmation, start requested (not
 * yet claimed), assessing, and parked on the named prerequisite. A route
 * screenshot cannot reach these: they need a pending task with an unfinished
 * declared prerequisite, which a scrubbed clone does not have.
 *
 * The zone reads `/api/tasks/:id/waiting`; each panel has its own task id and a
 * fetch shim answers that one URL (everything else passes through).
 */
import type { ReactNode } from 'react';
import TaskActionZone, { CoordinationRefusal } from '@/app/app/(protected)/missions/[id]/TaskActionZone';
import { coordinationHoldBody, makeWaitingReason } from '@buildd/core/waiting-reason';
import type { GateRefusal } from '@/lib/task-actions';

const DECLARED = makeWaitingReason('dep_declared', {
  because: 'it was declared as a dependency',
  blocker: { type: 'task', id: 'fx-prereq', label: '“Build the schema”', href: '#', live: true },
  provenance: { source: 'task_context', derivedFrom: 'tasks.dependsOn' },
});
const HOLD = coordinationHoldBody([DECLARED]);

type StartAnyway = { phase: 'requested' | 'assessing' | 'blocked'; label: string; executing: boolean; taskStatus: 'pending' | 'in_progress'; blockerTaskId?: string };
const PANELS: Array<{ id: string; label: string; title: string; held: boolean; startAnyway?: StartAnyway }> = [
  { id: 'fx-sa-offer', label: 'Blocked, pending: Start anyway offered', title: 'Add the API', held: true },
  {
    id: 'fx-sa-requested', label: 'Start requested, not yet claimed', title: 'Add the API', held: false,
    startAnyway: { phase: 'requested', label: 'Start requested, waiting for a runner', executing: false, taskStatus: 'pending' },
  },
  {
    id: 'fx-sa-assessing', label: 'Assessing what can proceed', title: 'Add the API', held: false,
    startAnyway: { phase: 'assessing', label: 'Assessing what can proceed without Build the schema', executing: true, taskStatus: 'in_progress' },
  },
  {
    id: 'fx-sa-parked', label: 'Parked on the named prerequisite', title: 'Add the API', held: true,
    startAnyway: { phase: 'blocked', label: 'Blocked on Build the schema: Needs the new API', executing: false, taskStatus: 'pending', blockerTaskId: 'fx-prereq' },
  },
];

let shimmed = false;
function installWaitingShim() {
  if (shimmed || typeof window === 'undefined') return;
  shimmed = true;
  const real = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const m = url.match(/\/api\/tasks\/(fx-sa-[a-z]+)\/waiting$/);
    const panel = m && PANELS.find(p => p.id === m[1]);
    if (!panel) return real(input, init);
    const body = {
      ...(panel.held ? HOLD : {}),
      waitingReasons: panel.held ? [DECLARED] : [],
      probed: true,
      ...(panel.startAnyway ? { startAnyway: panel.startAnyway } : {}),
    };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
}

const noop = () => {};

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section data-testid="start-anyway-fixture" data-state-label={label} className="space-y-2">
      <p className="section-label">{label}</p>
      <div className="border border-border-default bg-surface-1 p-4">{children}</div>
    </section>
  );
}

export default function StartAnywayFixture() {
  installWaitingShim();
  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 font-mono text-title font-semibold">Start anyway</h1>
      </header>
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6 md:px-8">
        {PANELS.slice(0, 1).map(p => (
          <Panel key={p.id} label={p.label}>
            <TaskActionZone taskId={p.id} workspaceId="fx-ws" phase="pending" isBlocked blockedByCount={1} backend="claude" lastError={null} worker={null} taskTitle={p.title} />
          </Panel>
        ))}
        <Panel label="Start anyway confirmation">
          <CoordinationRefusal refusal={HOLD as GateRefusal} pending={null} onForce={noop} onCancel={noop} taskTitle="Add the API" />
        </Panel>
        {PANELS.slice(1).map(p => (
          <Panel key={p.id} label={p.label}>
            <TaskActionZone taskId={p.id} workspaceId="fx-ws" phase="pending" isBlocked blockedByCount={1} backend="claude" lastError={null} worker={null} taskTitle={p.title} />
          </Panel>
        ))}
      </main>
    </div>
  );
}
