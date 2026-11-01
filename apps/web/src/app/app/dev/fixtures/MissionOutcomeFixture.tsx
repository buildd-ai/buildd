'use client';

/**
 * `?state=mission-outcome`: a completed mission page led by its outcome
 * (Navigation R-23 to R-27), with the real hero, Overview and Records sheet.
 * See mission-outcome-fixtures.ts for `&variant=`. Display only: the outcome
 * choice posts to the live route, so do not press it here.
 */
import { useEffect, useState } from 'react';
import MissionOverview from '@/app/app/(protected)/missions/[id]/MissionOverview';
import MissionOutcomeHero from '@/app/app/(protected)/missions/[id]/MissionOutcomeHero';
import MissionShippedHeader from '@/app/app/(protected)/missions/[id]/MissionShippedHeader';
import MissionRecordsSheet from '@/app/app/(protected)/missions/[id]/MissionRecordsSheet';
import { missionOutcomeFixture, missionOutcomeLinks, parseMissionOutcomeVariant, type MissionOutcomeFixture as Fixture, type MissionOutcomeVariant } from './mission-outcome-fixtures';

export default function MissionOutcomeFixture() {
  // Built after mount so server and client render alike.
  const [state, setState] = useState<{ variant: MissionOutcomeVariant; fixture: Fixture } | null>(null);
  useEffect(() => {
    const variant = parseMissionOutcomeVariant(new URLSearchParams(window.location.search));
    setState({ variant, fixture: missionOutcomeFixture(variant) });
  }, []);
  if (!state) return <div className="min-h-screen bg-surface-1" />;
  const { variant, fixture: f } = state;

  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures</p>
        <h1 className="mt-1 font-mono text-heading font-semibold">{`Completed mission outcome: ${variant}`}</h1>
        <nav aria-label="Fixture states" className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
          {missionOutcomeLinks().map(l => (
            <a key={l.href} href={l.href} className="shrink-0 border border-border-default bg-surface-2 px-2.5 py-1.5 font-mono text-meta text-text-secondary hover:border-border-strong hover:text-text-primary">
              {l.label}
            </a>
          ))}
        </nav>
      </header>
      <main data-testid="mission-outcome-fixture" className="mx-auto w-full max-w-[840px] px-4 py-6 md:px-8">
        <p className="font-mono text-meta text-text-muted">‹ Missions</p>
        <h2 className="mt-2 text-heading font-semibold text-text-primary">{f.title}</h2>
        <p className="mt-1 text-body text-text-secondary">{f.goal}</p>
        {f.hero
          ? (
            <MissionOutcomeHero missionId={f.missionId} view={f.hero}>
              {f.hero.class === 'mixed' && f.shipped && f.shipped.heroShots.length > 0 && <MissionShippedHeader missionId={f.missionId} view={{ ...f.shipped, lede: null, offPlan: [] }} embedded />}
            </MissionOutcomeHero>
          )
          : f.shipped && <MissionShippedHeader missionId={f.missionId} view={f.shipped} />}
        <div className="mt-6">
          <MissionOverview model={f.model} missionId={f.missionId} checks={f.checks} />
        </div>
        <div className="mt-10">
          <MissionRecordsSheet
            missionId={f.missionId}
            baseUrl="https://buildd.dev"
            records={f.records}
            allArtifacts={f.records}
            outcome={f.outcome}
            loadContent={async () => ({})}
          />
        </div>
      </main>
    </div>
  );
}
