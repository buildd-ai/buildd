'use client';

/**
 * `?state=mission-detail-compact`: mission detail as a phone meets it. The
 * real header (back, the ⋯ menu, title,
 * goal line, spec line) over the real Overview (the stage line, the decision
 * cards, the bar, the summary line and the task list), inside the app's
 * scroll root with the phone tab bar fixed over it. See
 * mission-detail-compact-fixtures.ts for `&variant=` and `&select=`.
 *
 * Display only: the actions post to the live routes, so do not press them here.
 */
import { selectStripCell } from './strip-select';
import { useEffect, useState } from 'react';
import DesignsSection from '@/components/DesignsSection';
import { DESIGN_PREVIEW_FIXTURE_SCREENS } from './DesignPreviewFixture';
import MissionsBottomNav from '@/components/MissionsBottomNav';
import MissionLayoutShell, { MissionBoardHeader } from '@/app/app/(protected)/missions/[id]/MissionLayoutShell';
import MissionOverview from '@/app/app/(protected)/missions/[id]/MissionOverview';
import MissionOverflowMenu from '@/app/app/(protected)/missions/[id]/MissionOverflowMenu';
import { stripFixtureId } from './mission-task-strip-fixtures';
import {
  missionDetailCompactFixture,
  missionDetailCompactLinks,
  parseMissionDetailCompact,
  type MissionDetailCompactFixture as Fixture,
} from './mission-detail-compact-fixtures';

const MISSION_ID = stripFixtureId(950);
const WORKSPACE_ID = stripFixtureId(951);

export default function MissionDetailCompactFixture() {
  // Built after mount: the clocks read the real now, so server and client render alike.
  const [fixture, setFixture] = useState<Fixture | null>(null);
  // `&design=1` adds the mission page's Design section around the sample file; `&design=unavailable`, storage unable to serve it.
  const [design, setDesign] = useState<string | null>(null);
  useEffect(() => {
    const { variant, select } = parseMissionDetailCompact(new URLSearchParams(window.location.search));
    setDesign(new URLSearchParams(window.location.search).get('design'));
    setFixture(missionDetailCompactFixture(variant, select, Date.now()));
  }, []);
  // `&select=`: open on that strip position, the way a tap would (the strip owns its selection).
  useEffect(() => {
    if (fixture?.selectIndex == null) return;
    selectStripCell([...document.querySelectorAll<HTMLButtonElement>('[data-testid="task-strip"] button[data-id]')], fixture.selectIndex);
  }, [fixture]);
  if (!fixture) return <div className="min-h-screen bg-surface-1" />;

  const { model, title, goal, variant } = fixture;
  const complete = variant === 'all-landed' || variant === 'delivered';
  const link = { missionId: MISSION_ID, from: null, initiativeId: null };
  const header = (content: React.ReactNode) => (
    <MissionBoardHeader
      back={{ label: 'Missions', href: '/app/missions' }}
      title={title}
      actions={
        <MissionOverflowMenu
          missionId={MISSION_ID}
          currentStatus={complete ? 'completed' : 'active'}
          cronExpression={null}
          workspaceId={WORKSPACE_ID}
          roles={[]}
          hasSchedule={false}
          isHeld={false}
          displayState={complete ? 'complete' : 'running'}
          visualReview={complete ? null : { initialOpen: false }}
        />
      }
      goal={goal}
      description={<p className="text-body text-text-secondary">{goal}</p>}
    >
      {content}
    </MissionBoardHeader>
  );

  return (
    <div className="flex h-dvh flex-col bg-surface-1 text-text-primary">
      <main data-scroll-root className="flex-1 overflow-y-auto overflow-x-hidden pb-16 md:pb-0">
        <nav aria-label="Fixture states" className="flex gap-1.5 overflow-x-auto border-b border-border-default px-4 py-2 md:px-8">
          {missionDetailCompactLinks().map(l => (
            <a key={l.href} href={l.href} className="shrink-0 border border-border-default bg-surface-2 px-2 py-1 font-mono text-meta text-text-secondary hover:text-text-primary">
              {l.label}
            </a>
          ))}
        </nav>
        <MissionLayoutShell
          initial="board"
          board={header(
            <MissionOverview
              model={model}
              completionText={variant === 'all-landed' ? 'Shipped readable export schedules and limits, checked on a phone and a desk.' : null}
              checks={fixture.checks}
              planTasks={fixture.planTasks}
              missionTitle={title}
              outcomeSpecTitles={fixture.specTitles}
              decisions={fixture.decisions}
              history={fixture.history}
              expectedMinutes={fixture.expectedMinutes ?? undefined}
              verify={fixture.verify ?? null}
              {...link}
            />,
          )}
          flow={header(null)}
          feed={header(null)}
        />
        {design ? (
          <div className="px-4 pb-6 md:px-8">
            <DesignsSection
              designs={[{
                id: 'fixture-mission-design',
                title: 'Navigation design (sample)',
                downloadUrl: '/app/dev/fixtures/design',
                view: {
                  revision: 1,
                  frameUrl: design === 'unavailable' ? null : '/app/dev/fixtures/design',
                  screens: DESIGN_PREVIEW_FIXTURE_SCREENS,
                  revisionNote: null,
                },
              }]}
            />
          </div>
        ) : null}
      </main>
      <MissionsBottomNav />
    </div>
  );
}
