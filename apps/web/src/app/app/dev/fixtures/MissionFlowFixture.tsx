'use client';

/**
 * `?state=mission-flow`: the mission Flow tab (FlowTimeline) over the
 * refined-UI prototype's two missions. See mission-flow-fixtures.ts for `&m=`.
 */
import { useEffect, useState } from 'react';
import FlowTimeline from '@/app/app/(protected)/missions/[id]/FlowTimeline';
import { stripFixtureId } from './mission-task-strip-fixtures';
import { missionFlowFixture, missionFlowLinks, parseMissionFlowVariant, type MissionFlowFixture as Fixture, type MissionFlowVariant } from './mission-flow-fixtures';

const MISSION_ID = stripFixtureId(950);

export default function MissionFlowFixture() {
  // Built after mount: the timeline's clock reads the real now, so server and client render alike.
  const [state, setState] = useState<{ variant: MissionFlowVariant; fixture: Fixture; sel: string | null } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const variant = parseMissionFlowVariant(q);
    const fixture = missionFlowFixture(variant, Date.now());
    const n = Number(q.get('sel'));
    setState({ variant, fixture, sel: Number.isInteger(n) && n > 0 ? fixture.idOf(n) : null });
  }, []);
  if (!state) return <div className="min-h-screen bg-surface-1" />;
  const { variant, fixture, sel } = state;
  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b border-border-default px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 text-heading font-semibold">{`Mission · Flow: ${variant}`}</h1>
        <nav aria-label="Fixture states" className="mt-3 flex flex-wrap gap-1.5">
          {missionFlowLinks().map(l => (
            <a key={l.href} href={l.href} className="border border-border-default bg-surface-2 px-2.5 py-1.5 font-mono text-meta text-text-secondary hover:border-border-strong hover:text-text-primary">
              {l.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-[1180px] px-4 pb-12 md:px-8">
        <FlowTimeline
          model={fixture.model}
          sameFiles={fixture.sameFiles}
          expectedMinutes={fixture.expectedMinutes}
          initialSelected={sel}
          missionId={MISSION_ID}
        />
      </main>
    </div>
  );
}
