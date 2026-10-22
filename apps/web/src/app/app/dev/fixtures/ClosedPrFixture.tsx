'use client';

/**
 * `?state=closed-pr&case=`: the real mission situation block for a closed,
 * unmerged deliverable, and the same mission once its replacement is recorded
 * (see closed-pr-fixtures.ts). Beside it, the closed PR's task status as the
 * task header reads it: still open, or "Merged in #N" through its successor.
 *
 * Display only: Confirm, Not this and Mark abandoned post to the live route,
 * so do not press them here.
 */
import { useEffect, useState } from 'react';
import MissionSituationBlock from '@/components/missions/MissionSituationBlock';
import { HeaderStatusPill } from '@/app/app/(protected)/tasks/[id]/TaskSidePanel';
import { deriveDeliveryView, type DeliverySnapshot } from '@/lib/workflow/projections';
import { CLOSED_PR_MISSION_ID, closedPrFixture, closedPrFixtureLinks, parseClosedPrFixtureCase, type ClosedPrFixture as Fixture } from './closed-pr-fixtures';

function supersededPill(prNumber: number, successor: number) {
  const snapshot: DeliverySnapshot = {
    id: 'fx-closed-pr', workspaceId: 'fx-ws', ownerTaskId: 'fx-closed-pr-task', repoFullName: 'acme/widgets', prNumber, baseRef: 'dev',
    state: 'SUPERSEDED', stateReason: null, version: 4, currentHeadSha: '9f3c2a17e0', currentRound: 1, maxRounds: 3,
    boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
    compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
    mergeCommitSha: null, supersededByPr: successor,
  };
  const v = deriveDeliveryView({ view: { delivery: snapshot, rounds: [], attempts: [] } })!;
  return <HeaderStatusPill status="completed" merged={false} delivery={{ headline: v.headline, owner: v.owner, needsYou: v.needsYou, stage: v.stage, detail: v.detail, prState: v.prState, state: v.state, supersededByPr: successor }} />;
}

export default function ClosedPrFixture() {
  // Read the URL after mount, so server and client render alike.
  const [fixture, setFixture] = useState<Fixture | null>(null);
  useEffect(() => {
    setFixture(closedPrFixture(parseClosedPrFixtureCase(new URLSearchParams(window.location.search))));
  }, []);
  if (!fixture) return <div className="min-h-screen bg-surface-1" />;
  const { task } = fixture;
  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 font-mono text-[18px] font-semibold">Closed PR: {fixture.case}</h1>
        <nav aria-label="Fixture states" className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
          {closedPrFixtureLinks().map(l => (
            <a key={l.href} href={l.href} className="shrink-0 border border-border-default bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-text-secondary hover:border-border-strong hover:text-text-primary">
              {l.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-8">
        <section className="flex flex-col gap-2">
          <h2 className="section-label">Mission</h2>
          <div className="border-2 border-border-strong bg-card p-4">
            <MissionSituationBlock missionId={CLOSED_PR_MISSION_ID} situation={fixture.situation} because={[]} />
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="section-label">Task</h2>
          <div data-testid="closed-pr-fixture-task" className="flex flex-wrap items-center gap-2.5 border border-border-default bg-surface-2 p-3">
            <span className="font-mono text-[13px]">{task.title}</span>
            <span className="font-mono text-[12px] text-text-muted">PR #{task.prNumber}</span>
            {task.supersededByPr != null
              ? supersededPill(task.prNumber, task.supersededByPr)
              : <HeaderStatusPill status="completed" merged={false} />}
          </div>
        </section>
      </main>
    </div>
  );
}
