'use client';

/**
 * `?state=entitlement-blocked`: a queued task held on a managed-runner plan
 * limit, in every shape the notice takes (the task sheet and task page
 * render this same component in place of Run now; the last two panels are the
 * integrated TaskActionZone, with and without a block: a self-hosted install
 * never has one, so it shows Run now and no upsell): hosted individual at 3 of 3,
 * team at 10 of 10, monthly runner-hours used up, and collapsed after
 * "Leave queued". Reaching any of these live needs a managed runner key and a
 * plan, so a route screenshot never does.
 */
import type { ReactNode } from 'react';
import type { EntitlementBlock } from '@buildd/shared';
import TaskActionZone from '../../(protected)/missions/[id]/TaskActionZone';
import EntitlementBlockedNotice from '@/components/entitlements/EntitlementBlockedNotice';

const INDIVIDUAL: EntitlementBlock = { kind: 'concurrency', key: 'managed_runner.concurrency', active: 3, limit: 3, scope: 'individual' };
const TEAM: EntitlementBlock = { kind: 'concurrency', key: 'managed_runner.concurrency', active: 10, limit: 10, scope: 'team' };
const HOURS: EntitlementBlock = { kind: 'usage', key: 'managed_runner.hours', unit: 'runner_hours', used: 50, limit: 50, resetsAt: '2026-11-01T00:00:00.000Z', scope: 'individual' };

/** A queued task as the task sheet and page render it: the shared action zone. */
const QUEUED = { workspaceId: 'ws-fixture', phase: 'pending' as const, isBlocked: false, blockedByCount: 0, backend: 'claude' as const, worker: null, lastError: null, historyHref: null };

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section data-testid="entitlement-fixture" data-state-label={label} className="space-y-2">
      <p className="section-label">{label}</p>
      {children}
    </section>
  );
}

export default function EntitlementBlockedFixture() {
  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 font-mono text-[18px] font-semibold">Queued on a plan limit</h1>
      </header>
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6 md:px-8">
        <Panel label="Individual, 3 of 3">
          <EntitlementBlockedNotice block={INDIVIDUAL} />
        </Panel>
        <Panel label="Team, 10 of 10">
          <EntitlementBlockedNotice block={TEAM} />
        </Panel>
        <Panel label="Runner-hours used up">
          <EntitlementBlockedNotice block={HOURS} />
        </Panel>
        <Panel label="After Leave queued">
          <EntitlementBlockedNotice block={INDIVIDUAL} defaultCollapsed />
        </Panel>
        <Panel label="Task sheet/page, queued on a plan limit">
          <TaskActionZone {...QUEUED} taskId="fx-queued-blocked" entitlementBlock={INDIVIDUAL} />
        </Panel>
        <Panel label="Task sheet/page, queued, no block (self-hosted: no upsell)">
          <TaskActionZone {...QUEUED} taskId="fx-queued-free" entitlementBlock={null} />
        </Panel>
      </main>
    </div>
  );
}
