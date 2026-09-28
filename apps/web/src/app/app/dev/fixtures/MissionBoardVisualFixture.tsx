'use client';

/**
 * `?state=mission-board-visual`: the real mission Board, Lanes or Feed with a
 * visual review model, wired as the mission page wires them (one provider,
 * the footer's Screens row, the Settings toggle), over the in-memory fixture
 * transport. See mission-board-visual-fixtures.ts for the query.
 */
import { useEffect, useMemo, useState } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import { createFixtureVisualReviewTransport } from '@/components/visual-review/fixture-transport';
import { buildDeliverySteps } from '@/lib/mission-delivery';
import MissionBoard from '@/app/app/(protected)/missions/[id]/MissionBoard';
import MissionLanes from '@/app/app/(protected)/missions/[id]/MissionLanes';
import MissionFeedLayout from '@/app/app/(protected)/missions/[id]/MissionFeedLayout';
import MissionScreensRow from '@/app/app/(protected)/missions/[id]/MissionScreensRow';
import MissionVisualReviewSetting from '@/app/app/(protected)/missions/[id]/MissionVisualReviewSetting';
import { MissionVisualReviewProvider } from '@/app/app/(protected)/missions/[id]/MissionVisualReview';
import {
  MISSION_BOARD_VISUAL_LAYOUTS,
  missionBoardVisualFixture,
  missionBoardVisualLinks,
  parseMissionBoardVisualParams,
  type MissionBoardVisualParams,
} from './mission-board-visual-fixtures';

export default function MissionBoardVisualFixture() {
  // Read the URL after mount, so server and client render alike.
  const [params, setParams] = useState<MissionBoardVisualParams | null>(null);
  useEffect(() => {
    setParams(parseMissionBoardVisualParams(new URLSearchParams(window.location.search)));
  }, []);
  if (!params) return <div className="min-h-screen bg-surface-1" />;
  return <View params={params} />;
}

function visualStepOf(model: VisualReviewModel) {
  const s = model.summary;
  return buildDeliverySteps({
    missionStatus: 'active', totalTasks: 4, completedTasks: 2, awaitingMerge: 0, integrationPr: null,
    criteria: { total: 0, passed: null, overall: null }, mergedAt: [], release: null, budget: null,
    visual: { shots: s.shots, ok: s.ok, issues: s.issues, unsure: s.unsure, ...(s.bootFailed ? { bootFailed: true } : {}) },
    visualPhase: model,
  }).find(st => st.key === 'visual') ?? null;
}

function View({ params }: { params: MissionBoardVisualParams }) {
  const transport = useMemo(
    () => createFixtureVisualReviewTransport(params.phase, params.options, { latencyMs: 350 }),
    [params],
  );
  const [visual] = useState(() => transport.model());
  // Anchored to the mount time: the board's clocks tick from the real now.
  const [t0] = useState(() => Date.now() - (params.complete ? 60 : 30) * 60_000);
  const board = useMemo(() => missionBoardVisualFixture(visual, { complete: params.complete, t0 }), [visual, params.complete, t0]);
  const link = { missionId: visual.missionId, from: null, initiativeId: null };
  const here = (layout: string) => {
    const q = new URLSearchParams(window.location.search);
    q.set('layout', layout);
    return `?${q.toString()}`;
  };

  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 font-mono text-[18px] font-semibold">{`Mission ${params.layout}: ${visual.phase}`}</h1>
        <nav aria-label="Fixture states" className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
          {missionBoardVisualLinks().map(l => (
            <a key={l.href} href={l.href} className="shrink-0 border border-border-default bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-text-secondary hover:border-border-strong hover:text-text-primary">
              {l.label}
            </a>
          ))}
          {MISSION_BOARD_VISUAL_LAYOUTS.map(l => (
            <a key={l} href={here(l)} className="shrink-0 border border-border-strong bg-surface-3 px-2.5 py-1.5 font-mono text-[12px] text-text-primary">{`layout: ${l}`}</a>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-2 md:px-8">
        <MissionVisualReviewProvider missionId={visual.missionId} visual={visual} transport={transport}>
          {params.layout === 'lanes' ? (
            <MissionLanes model={board} completionText={null} visual={visual} {...link} />
          ) : params.layout === 'feed' ? (
            <MissionFeedLayout model={board} completionText={null} timeZone="UTC" visual={visual} {...link} />
          ) : (
            <MissionBoard model={board} completionText={params.complete ? 'Shipped the example screens and checked them on a phone and a desktop.' : null} visual={visual} {...link} />
          )}
          <div data-testid="mission-board-footer" className="mt-10">
            <MissionScreensRow missionId={visual.missionId} step={visualStepOf(visual)} />
            <div className="border-t border-border-default py-4">
              <p className="section-label mb-2">Settings sheet (preview)</p>
              <MissionVisualReviewSetting missionId={visual.missionId} initialEnabled visual={visual} />
            </div>
          </div>
        </MissionVisualReviewProvider>
      </main>
    </div>
  );
}
