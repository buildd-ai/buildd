'use client';

/**
 * `?state=coordination-hold`: a queued task a coordination gate holds, in the
 * shapes the task sheet / task page / mission drawer render (all through
 * `TaskActionZone`): the waiting line with its "Why" drilldown, Run now's
 * refusal with the Force start confirmation, a wait no force lifts, a task
 * blocked only by creation-time migration-overlap edges (the "migration slot"
 * headline, with its red line), and a local mission held by coordination too
 * (one press lifts both). Reaching these live needs an open PR or in-flight
 * task overlapping a pending one, so a route screenshot never does.
 */
import type { ReactNode } from 'react';
import WaitingLine from '@/components/tasks/WaitingLine';
import { CoordinationRefusal } from '@/app/app/(protected)/missions/[id]/TaskActionZone';
import { coordinationHoldBody, makeWaitingReason } from '@buildd/core/waiting-reason';
import type { GateRefusal } from '@/lib/task-actions';

const PR_HOLD = makeWaitingReason('pr_overlap_ended', {
  because: 'both edit packages/core/db/schema.ts',
  blocker: { type: 'pr', id: '1234', label: 'PR #1234', href: 'https://github.com/example/repo/pull/1234', live: false },
  overlap: { areas: [{ area: 'core/db', count: 1 }], pathCount: 1, paths: ['packages/core/db/schema.ts'], basis: 'declared' },
  provenance: { source: 'probe', derivedFrom: 'claim layer 1' },
});
const LEASE_HOLD = makeWaitingReason('lease_overlap', {
  because: 'both edit 6 files in web, runner',
  blocker: { type: 'task', id: 'holder', label: '“runner: claim waiter fix”', href: '#', live: true },
  overlap: {
    areas: [{ area: 'web', count: 4 }, { area: 'runner', count: 2 }],
    pathCount: 6,
    paths: [
      'apps/web/src/app/api/workers/claim/route.ts', 'apps/web/src/app/api/workers/claim/claim-plan-input.ts',
      'apps/web/src/lib/dispatch-authority.ts', 'apps/web/src/lib/path-claim-check.ts',
      'apps/runner/src/workers.ts', 'apps/runner/src/worker-sync.ts',
    ],
    basis: 'lease',
  },
  provenance: { source: 'probe', derivedFrom: 'claim layer 2' },
});
const MISSION_CAP = makeWaitingReason('mission_concurrent', {
  because: 'the mission runs at most 2 tasks at once and 2 are running',
  blocker: { type: 'mission', id: 'm', label: 'the mission limit', href: '#' },
  provenance: { source: 'probe', derivedFrom: 'missions.maxConcurrentTasks' },
});
const ROLE_GAP = makeWaitingReason('role_unavailable', {
  because: 'no online runner offers the builder role',
  provenance: { source: 'runner_fleet', derivedFrom: 'fleet skills' },
});
const DECLARED = makeWaitingReason('dep_declared', {
  because: 'it was declared as a dependency',
  blocker: { type: 'task', id: 'd1', label: '“design the API first”', href: '#' },
  provenance: { source: 'task_context', derivedFrom: 'tasks.dependsOn' },
});
const migrationEdge = (n: number) => makeWaitingReason('dep_inferred', {
  because: 'both change migrations in core/db',
  blocker: { type: 'task', id: `h${n}`, label: `“unrelated schema task ${n}”`, href: '#', live: n === 1 },
  overlap: { areas: [{ area: 'core/db', count: 1 }], pathCount: 1, paths: ['packages/core/db/schema.ts'], basis: 'declared', overlapKind: 'migration' },
  provenance: { source: 'task_context', derivedFrom: 'tasks.pathDeclaration.inferredDependsOn' },
});
const EDGES = [1, 2, 3, 4, 5].map(migrationEdge);
const LOCAL = makeWaitingReason('mission_local', {
  because: "its mission runs in a person's own session, so runners do not pick up its tasks",
  blocker: { type: 'mission', id: 'm', label: 'a local-session mission', href: '#' },
  provenance: { source: 'probe', derivedFrom: "missions.executor='local'" },
});

const refusalOf = (reasons: typeof PR_HOLD[]): GateRefusal => coordinationHoldBody(reasons) as GateRefusal;
const noop = () => {};

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section data-testid="coordination-fixture" data-state-label={label} className="space-y-2">
      <p className="section-label">{label}</p>
      <div className="border border-border-default bg-surface-1 p-4">{children}</div>
    </section>
  );
}

export default function CoordinationHoldFixture() {
  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 font-mono text-title font-semibold">Held by coordination</h1>
      </header>
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6 md:px-8">
        <Panel label="Queued, held by an open PR">
          <WaitingLine reasons={[PR_HOLD]}>
            <button type="button" className="inline-flex min-h-11 items-center px-3 font-mono text-meta text-text-secondary">Force start…</button>
          </WaitingLine>
        </Panel>
        <Panel label="Run now refused: Force start confirmation">
          <CoordinationRefusal refusal={refusalOf([PR_HOLD])} pending={null} onForce={noop} onCancel={noop} taskTitle="PR scope verification" />
        </Panel>
        <Panel label="Two holds, many files">
          <CoordinationRefusal refusal={refusalOf([LEASE_HOLD, MISSION_CAP])} pending={null} onForce={noop} onCancel={noop} />
        </Panel>
        <Panel label="Blocked only by migration-overlap ordering (not dependencies)">
          <WaitingLine reasons={EDGES}>
            <button type="button" className="inline-flex min-h-11 items-center px-3 font-mono text-meta text-text-secondary">Force start…</button>
          </WaitingLine>
        </Panel>
        <Panel label="Local mission + migration ordering: one Force start lifts both">
          <CoordinationRefusal refusal={refusalOf([LOCAL, ...EDGES.slice(0, 3)])} pending={null} onForce={noop} onCancel={noop} taskTitle="Add the run evidence table" />
        </Panel>
        <Panel label="A declared dependency stays (no Force start)">
          <WaitingLine reasons={[DECLARED, ...EDGES.slice(0, 2)]} />
        </Panel>
        <Panel label="Can't be forced: fix the capability instead">
          <CoordinationRefusal refusal={refusalOf([PR_HOLD, ROLE_GAP])} pending={null} onForce={noop} onCancel={noop} />
        </Panel>
        <Panel label="Changed under the confirmation (409)">
          <CoordinationRefusal refusal={{ ...refusalOf([LEASE_HOLD]), reasonsChanged: true }} pending={null} onForce={noop} onCancel={noop} />
        </Panel>
      </main>
    </div>
  );
}
