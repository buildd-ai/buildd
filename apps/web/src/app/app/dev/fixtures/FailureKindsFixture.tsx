'use client';

/**
 * `?state=failure-kinds`: the three failures a task can show, side by side. A
 * worker that died offers retry and a backend switch; work that landed whose
 * audit failed says so and offers neither; an audit that never ran because
 * its prerequisite failed names that task and offers no retry (spec 072de598 I-14).
 */
import TaskActionZone from '../../(protected)/missions/[id]/TaskActionZone';

const COMMON = { workspaceId: 'ws-fixture', phase: 'failed' as const, isBlocked: false, blockedByCount: 0, backend: 'claude' as const, worker: null, historyHref: '#' };

export default function FailureKindsFixture() {
  return (
    <main className="mx-auto max-w-xl space-y-8 p-4">
      <section data-testid="failure-kind" data-kind="execution" className="space-y-2">
        <h2 className="font-mono text-meta text-text-muted">Worker failed</h2>
        <TaskActionZone {...COMMON} taskId="fx-exec" failureKind="execution" lastError={{ excerpt: 'Tests failed: 3 of 12' }} />
      </section>
      <section data-testid="failure-kind" data-kind="verification" className="space-y-2">
        <h2 className="font-mono text-meta text-text-muted">Implementation landed, audit failed</h2>
        <TaskActionZone {...COMMON} taskId="fx-verify" failureKind="verification" lastError={null} />
      </section>
      <section data-testid="failure-kind" data-kind="dependency" className="space-y-2">
        <h2 className="font-mono text-meta text-text-muted">Audit never ran, prerequisite failed</h2>
        <TaskActionZone {...COMMON} taskId="fx-dependency" failureKind="dependency" taskTitle="[surface audit] Fixture mission" waitingOn={{ taskId: 'fx-exec', title: 'Make PR review decisions commit-scoped and truthful' }} lastError={null} />
      </section>
    </main>
  );
}
