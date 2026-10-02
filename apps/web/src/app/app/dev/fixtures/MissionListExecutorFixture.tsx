'use client';

/**
 * `?state=mission-list-executor`: the real missions-list cards for one mission
 * under each executor setting. See mission-list-executor-fixtures.ts.
 */
import { useEffect, useState } from 'react';
import { ActiveMissionCard, MiniMissionCard } from '@/components/missions/MissionListCards';
import { HomeMissionsSummary } from '@/app/app/(protected)/home/HomeMissionsSummary';
import { missionListExecutorFixture, type ExecutorFixtureCard } from './mission-list-executor-fixtures';

export default function MissionListExecutorFixture() {
  // Built after mount: the cards' clocks read the real now, so server and client render alike.
  const [cards, setCards] = useState<ExecutorFixtureCard[] | null>(null);
  useEffect(() => setCards(missionListExecutorFixture()), []);
  return (
    <div className="min-h-screen bg-surface-1 px-4 py-6 md:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <h1 className="text-lg font-semibold text-text-primary">Missions list: executor</h1>
        {/* Home's compact rows over the same models: the stranded row carries its CTA. */}
        {cards && (
          <section data-testid="fixture-home-rows" className="flex flex-col gap-2">
            <p className="font-mono text-xs text-text-secondary">Home: the same missions as compact rows</p>
            <HomeMissionsSummary
              rows={cards.filter(c => c.model.kind === 'active').map(c => ({ view: c.view, model: c.model }))}
              total={cards.length}
              shippedToday={0}
            />
          </section>
        )}
        {cards?.map(c => (
          <section key={c.view.id} className="flex flex-col gap-2">
            <p className="font-mono text-xs text-text-secondary">{c.caption}</p>
            {c.model.kind === 'active'
              ? <ActiveMissionCard view={c.view} model={c.model} workspaceName="Example workspace" />
              : <MiniMissionCard view={c.view} model={c.model} workspaceName="Example workspace" />}
          </section>
        ))}
      </div>
    </div>
  );
}
