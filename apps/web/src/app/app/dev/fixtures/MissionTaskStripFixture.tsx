'use client';

/**
 * `?state=mission-task-strip`: the real mission Board with its interactive
 * Landed strip and tethered drawer, plus the real situation block wired the
 * way the mission page wires it (its single-task affordance points at the
 * drawer). See mission-task-strip-fixtures.ts for `&variant=`.
 *
 * Display only: the drawer's actions post to the live routes, so do not press
 * them here.
 */
import { useEffect, useState } from 'react';
import MissionBoard from '@/app/app/(protected)/missions/[id]/MissionBoard';
import MissionSituationBlock from '@/components/missions/MissionSituationBlock';
import type { MissionSituation } from '@/lib/mission-state-view';
import {
  missionTaskStripFixture,
  missionTaskStripLinks,
  parseMissionTaskStripVariant,
  stripFixtureId,
  type MissionTaskStripFixture as Fixture,
  type MissionTaskStripVariant,
} from './mission-task-strip-fixtures';

const MISSION_ID = stripFixtureId(900);
const WORKSPACE_ID = stripFixtureId(901);

/** The local mission's situation, as the accessor phrases it for one open task. */
function localSituation(taskId: string): MissionSituation {
  return {
    headline: 'Waiting for a local session to claim the open task.',
    tone: 'neutral',
    focus: { kind: 'task', tone: 'neutral', label: '1 open task', count: 1, taskIds: [taskId], byStatus: { pending: 1 }, local: true },
    nextAction: null,
    alsoOutstanding: [],
    derivedFrom: 'mission.executor',
  } as MissionSituation;
}

export default function MissionTaskStripFixture() {
  // Built after mount: the board's clocks read the real now, so server and client render alike.
  const [state, setState] = useState<{ variant: MissionTaskStripVariant; fixture: Fixture } | null>(null);
  useEffect(() => {
    const variant = parseMissionTaskStripVariant(new URLSearchParams(window.location.search));
    setState({ variant, fixture: missionTaskStripFixture(variant, Date.now()) });
  }, []);
  if (!state) return <div className="min-h-screen bg-surface-1" />;
  const { variant, fixture } = state;
  const openTask = variant === 'mid-open' ? stripFixtureId(9) : null;
  const situation = openTask ? localSituation(openTask) : null;

  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 font-mono text-[18px] font-semibold">{`Mission Landed strip: ${variant}`}</h1>
        <nav aria-label="Fixture states" className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
          {missionTaskStripLinks().map(l => (
            <a key={l.href} href={l.href} className="shrink-0 border border-border-default bg-surface-2 px-2.5 py-1.5 font-mono text-meta text-text-secondary hover:border-border-strong hover:text-text-primary">
              {l.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-2 md:px-8">
        <MissionBoard
          model={fixture.model}
          missionId={MISSION_ID}
          workspaceId={WORKSPACE_ID}
          executor={fixture.executor}
          stripFocus={situation && openTask ? { taskId: openTask, reason: situation.headline } : null}
          notice={situation ? <MissionSituationBlock missionId={MISSION_ID} situation={situation} because={[]} /> : null}
          completionText={variant === 'all-landed' ? 'Shipped the runner and checked it end to end.' : null}
        />
      </main>
    </div>
  );
}
