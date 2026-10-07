'use client';

/**
 * `?state=coordination-hold`: a queued task a coordination gate holds, in the
 * shapes the task sheet / task page / mission drawer render (all through
 * `TaskActionZone`): the waiting line with its "Why" drilldown, Run now's
 * refusal with the Force start confirmation, a wait no force lifts, and
 * after a Force start. Reaching these live needs an open PR overlapping a
 * pending task, so a route screenshot never does.
 */
import type { ReactNode } from 'react';
import WaitingLine from '@/components/tasks/WaitingLine';
import { CoordinationRefusal } from '@/app/app/(protected)/missions/[id]/TaskActionZone';
import { coordinationHoldBody, makeWaitingReason } from '@buildd/core/waiting-reason';
import type { GateRefusal } from '@/lib/task-actions';

const PR_HOLD = makeWaitingReason('pr_overlap_ended', {
  because: 'both edit packages/core/db/schema.ts',
  blocker: { type: 'pr', id: '3818', label: 'PR #3818', href: 'https://github.com/buildd-ai/buildd/pull/3818', live: false },
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
const MUTEX = makeWaitingReason('scope_undeclared_mutex', {
  because: 'neither task declares the files it edits, so the mission runs one at a time',
  blocker: { type: 'task', id: 'peer', label: '“investigate flaky deploy”', href: '#', live: true },
  provenance: { source: 'probe', derivedFrom: 'advisory_manifest' },
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
        <h1 className="mt-1 font-mono text-[18px] font-semibold">Held by coordination</h1>
      </header>
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6 md:px-8">
        <Panel label="Queued, held by an open PR">
          <WaitingLine reasons={[PR_HOLD]}>
            <button type="button" className="inline-flex min-h-11 items-center px-3 font-mono text-meta text-text-secondary">Force start…</button>
          </WaitingLine>
        </Panel>
        <Panel label="Run now refused: Force start confirmation">
          <CoordinationRefusal refusal={refusalOf([PR_HOLD])} pending={null} onForce={noop} onCancel={noop} />
        </Panel>
        <Panel label="Two holds, many files">
          <CoordinationRefusal refusal={refusalOf([LEASE_HOLD, MISSION_CAP])} pending={null} onForce={noop} onCancel={noop} />
        </Panel>
        <Panel label="Can't be forced">
          <CoordinationRefusal refusal={refusalOf([MUTEX])} pending={null} onForce={noop} onCancel={noop} />
        </Panel>
        <Panel label="Changed under the confirmation (409)">
          <CoordinationRefusal refusal={{ ...refusalOf([LEASE_HOLD]), reasonsChanged: true }} pending={null} onForce={noop} onCancel={noop} />
        </Panel>
      </main>
    </div>
  );
}
