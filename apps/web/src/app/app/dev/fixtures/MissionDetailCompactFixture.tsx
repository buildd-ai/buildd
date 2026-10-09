'use client';

/**
 * `?state=mission-detail-compact`: mission detail as a phone meets it. The
 * real header (back, title, state chip, Verified pill, clock, Overview · Flow
 * · History, the overflow menu (which starts the visual review), goal line) over the real Overview,
 * inside the app's scroll root with the phone tab bar fixed over it. See
 * mission-detail-compact-fixtures.ts for `&variant=` and `&select=`.
 *
 * Display only: the actions post to the live routes, so do not press them here.
 */
import { useEffect, useState } from 'react';
import type { GoalCriterion } from '@buildd/shared';
import MissionsBottomNav from '@/components/MissionsBottomNav';
import { getMissionStateChip } from '@/lib/mission-helpers';
import MissionLayoutShell, { MissionBoardHeader } from '@/app/app/(protected)/missions/[id]/MissionLayoutShell';
import MissionOverview from '@/app/app/(protected)/missions/[id]/MissionOverview';
import MissionVerifiedPill from '@/app/app/(protected)/missions/[id]/MissionVerifiedPill';
import MissionOverflowMenu from '@/app/app/(protected)/missions/[id]/MissionOverflowMenu';
import { stripFixtureId } from './mission-task-strip-fixtures';
import {
  COMPACT_GOAL,
  missionDetailCompactFixture,
  missionDetailCompactLinks,
  parseMissionDetailCompact,
  type MissionDetailCompactFixture as Fixture,
} from './mission-detail-compact-fixtures';

const MISSION_ID = stripFixtureId(950);
const WORKSPACE_ID = stripFixtureId(951);
const CRITERIA: GoalCriterion[] = [
  { type: 'all_prs_merged', label: 'All PRs merged' },
  { type: 'no_open_tasks', label: 'No open tasks' },
  { type: 'command', command: 'bun run test', label: 'Unit tests pass' },
];

export default function MissionDetailCompactFixture() {
  // Built after mount: the clocks read the real now, so server and client render alike.
  const [fixture, setFixture] = useState<Fixture | null>(null);
  useEffect(() => {
    const { variant, select } = parseMissionDetailCompact(new URLSearchParams(window.location.search));
    setFixture(missionDetailCompactFixture(variant, select, Date.now()));
  }, []);
  // `&select=`: open on that strip position, the way a tap would (the strip owns its selection).
  useEffect(() => {
    if (fixture?.selectIndex == null) return;
    document.querySelectorAll<HTMLButtonElement>('[data-testid="task-strip"] button[data-id]')[fixture.selectIndex]?.click();
  }, [fixture]);
  if (!fixture) return <div className="min-h-screen bg-surface-1" />;

  const { model, title, deliveries, variant } = fixture;
  const complete = variant === 'all-landed';
  const chip = getMissionStateChip(complete ? 'complete' : 'running');
  const link = { missionId: MISSION_ID, from: null, initiativeId: null };
  const header = (content: React.ReactNode) => (
    <MissionBoardHeader
      back={{ label: 'Missions', href: '/app/missions' }}
      title={title}
      chip={chip}
      verified={
        <MissionVerifiedPill
          missionId={MISSION_ID}
          criteria={CRITERIA}
          criteriaState={null}
          autoVerify
          readonly={complete}
          overall={complete ? 'pass' : null}
        />
      }
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
      goal={COMPACT_GOAL}
      description={<p className="text-body text-text-secondary">{COMPACT_GOAL}</p>}
      serverNow={model.now}
      startedAt={model.startedAt}
      endedAt={model.endedAt}
      activeMs={model.activeMs}
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
              completionText={complete ? 'Shipped readable export schedules and limits, checked on a phone and a desk.' : null}
              workspaceId={WORKSPACE_ID}
              executor="runner"
              deliveries={deliveries}
              {...link}
            />,
          )}
          flow={header(null)}
          feed={header(null)}
        />
      </main>
      <MissionsBottomNav />
    </div>
  );
}
