'use client';

/**
 * `?state=mission-strip-lanes`: the compact-lanes EXPERIMENT beside the
 * production flat strip, on one set of rows per dependency shape, at the
 * mission page's, the missions list's and Home's densities. The strips are
 * the real components; only the scope (`data-strip-layout`) differs between
 * the columns. See mission-strip-lanes-fixtures.ts for `&layout=` and `&shape=`.
 */
import { useEffect, useState } from 'react';
import { LandedMeter } from '@/app/app/(protected)/missions/[id]/MissionBoardParts';
import PhaseBar from '@/components/missions/PhaseBar';
import {
  defaultStripSelection,
  slotMarks,
  stripLayoutScope,
  stripMarks,
  stripSlots,
  type StripLayout,
} from '@/lib/mission-task-strip';
import {
  laneFixtureLinks,
  laneShapeFixture,
  parseLanesFixtureParams,
  type LaneShapeFixture,
  type LanesFixtureParams,
} from './mission-strip-lanes-fixtures';

function DetailStrip({ fx }: { fx: LaneShapeFixture }) {
  const slots = stripSlots(fx.board);
  const selectedId = defaultStripSelection(slots) ?? slots[0]?.id ?? '';
  const sel = slots.findIndex(s => s.id === selectedId);
  const marks = slotMarks(slots, stripMarks(fx.board, selectedId).marks, sel);
  return (
    <div className="[--strip-gap:4px]">
      <LandedMeter model={fx.board} variant="band" compact selection={{ slots, selectedId, marks, onSelect: () => {} }} />
    </div>
  );
}

function Column({ fx, layout }: { fx: LaneShapeFixture; layout: StripLayout }) {
  return (
    <div {...stripLayoutScope(layout)} data-testid="lanes-fixture-column" className="flex min-w-0 flex-col gap-3">
      <p className="font-mono text-eyebrow uppercase tracking-[1.5px] text-text-muted">{layout === 'flat' ? 'A · flat (production)' : 'B · lanes (experiment)'}</p>
      <div>
        <p className="mb-1 font-mono text-[11px] text-text-muted">Mission page</p>
        <DetailStrip fx={fx} />
      </div>
      <div>
        <p className="mb-1 font-mono text-[11px] text-text-muted">Missions list</p>
        <PhaseBar phases={fx.list.phases} />
      </div>
      <div>
        <p className="mb-1 font-mono text-[11px] text-text-muted">Home</p>
        <PhaseBar phases={fx.list.phases} size="sm" />
      </div>
    </div>
  );
}

export default function MissionStripLanesFixture() {
  const [params, setParams] = useState<LanesFixtureParams | null>(null);
  useEffect(() => setParams(parseLanesFixtureParams(new URLSearchParams(window.location.search))), []);
  if (!params) return <div className="min-h-screen bg-surface-1" />;
  return (
    <div className="min-h-screen bg-surface-1 text-text-primary">
      <header className="border-b-2 border-border-strong px-4 py-4 md:px-8">
        <p className="section-label">Dev fixtures · experiment</p>
        <h1 className="mt-1 font-mono text-[18px] font-semibold">Mission strip: flat vs compact lanes</h1>
        <nav aria-label="Fixture states" className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
          {laneFixtureLinks().map(l => (
            <a key={l.href} href={l.href} className="shrink-0 border border-border-default bg-surface-2 px-2.5 py-1.5 font-mono text-meta text-text-secondary hover:border-border-strong hover:text-text-primary">
              {l.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-4 md:px-8">
        {params.shapes.map(name => {
          const fx = laneShapeFixture(name);
          return (
            <section key={name} data-testid="lanes-fixture-shape" data-shape={name} className="card flex flex-col gap-3 p-4">
              <h2 className="font-mono text-[14px] font-semibold">{fx.caption}</h2>
              <div className={`grid gap-6 ${params.layouts.length > 1 ? 'md:grid-cols-2' : ''}`}>
                {params.layouts.map(layout => <Column key={layout} fx={fx} layout={layout} />)}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
