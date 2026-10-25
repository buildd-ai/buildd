'use client';

/**
 * `?state=coordination-hold`: a queued task a claim gate holds, in the shapes
 * the task sheet / task page / mission drawer render (all through
 * `TaskActionZone`): the waiting line with its "Why" drilldown, Run now's
 * refusal with the Force start confirmation for a limit, a lane wait no force
 * lifts (spec: Overlap scheduling; Health › Queue R-10), and a local mission
 * held by a limit too (one press lifts both). Reaching these live needs a
 * held lane or a busy mission, so a route screenshot never does.
 */
import type { ReactNode } from 'react';
import WaitingLine from '@/components/tasks/WaitingLine';
import { CoordinationRefusal } from '@/app/app/(protected)/missions/[id]/TaskActionZone';
import { coordinationHoldBody, makeWaitingReason } from '@buildd/core/waiting-reason';
import type { GateRefusal } from '@/lib/task-actions';

const LANE_PR = makeWaitingReason('lane', {
  because: 'both edit packages/core/db/schema.ts, and PR #1234 holds the lane until it merges or closes',
  blocker: { type: 'pr', id: '1234', label: 'PR #1234', href: 'https://github.com/example/repo/pull/1234', live: false },
  overlap: { areas: [{ area: 'core/db', count: 1 }], pathCount: 1, paths: ['packages/core/db/schema.ts'], basis: 'declared' },
  lane: { lane: 'migration', holderTaskId: 'holder', position: null },
  provenance: { source: 'probe', derivedFrom: 'claim layer 1' },
});
const MISSION_BUDGET = makeWaitingReason('mission_budget', {
  because: 'the mission spent its $20.00 budget',
  blocker: { type: 'mission', id: 'm', label: 'the mission budget', href: '#' },
  provenance: { source: 'probe', derivedFrom: 'missions.budgetUsd' },
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
const LANE_SECOND = makeWaitingReason('lane', {
  because: 'waiting in the migration lane at position 2, behind task h1 (PR #1220) which holds it',
  blocker: { type: 'task', id: 'h1', label: '“add the run evidence table”', href: '#', live: true },
  lane: { lane: 'migration', holderTaskId: 'h1', position: 2 },
  provenance: { source: 'probe', derivedFrom: 'serial_lane_entries (claim-order laneOrderBy)' },
});
const LOCAL = makeWaitingReason('mission_local', {
  because: "its mission runs in a person's own session, so runners do not pick up its tasks",
  blocker: { type: 'mission', id: 'm', label: 'a mission run from your session', href: '#' },
  provenance: { source: 'probe', derivedFrom: "missions.executor='local'" },
});

const refusalOf = (reasons: typeof LANE_PR[]): GateRefusal => coordinationHoldBody(reasons) as GateRefusal;
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
        <Panel label="Queued, in the schema lane behind an open PR (no Force start)">
          <WaitingLine reasons={[LANE_PR]} />
        </Panel>
        <Panel label="Queued, 2nd in the schema lane">
          <WaitingLine reasons={[LANE_SECOND]} />
        </Panel>
        <Panel label="Run now refused by a limit: Force start confirmation">
          <CoordinationRefusal refusal={refusalOf([MISSION_CAP])} pending={null} onForce={noop} onCancel={noop} taskTitle="PR scope verification" />
        </Panel>
        <Panel label="Two limits">
          <CoordinationRefusal refusal={refusalOf([MISSION_BUDGET, MISSION_CAP])} pending={null} onForce={noop} onCancel={noop} />
        </Panel>
        <Panel label="Local mission + mission limit: one Force start lifts both">
          <CoordinationRefusal refusal={refusalOf([LOCAL, MISSION_CAP])} pending={null} onForce={noop} onCancel={noop} taskTitle="Add the run evidence table" />
        </Panel>
        <Panel label="A declared dependency stays (no Force start)">
          <WaitingLine reasons={[DECLARED, LANE_SECOND]} />
        </Panel>
        <Panel label="Can't be forced: a lane, and a capability to fix">
          <CoordinationRefusal refusal={refusalOf([LANE_PR, ROLE_GAP])} pending={null} onForce={noop} onCancel={noop} />
        </Panel>
        <Panel label="Changed under the confirmation (409)">
          <CoordinationRefusal refusal={{ ...refusalOf([MISSION_CAP]), reasonsChanged: true }} pending={null} onForce={noop} onCancel={noop} />
        </Panel>
      </main>
    </div>
  );
}
