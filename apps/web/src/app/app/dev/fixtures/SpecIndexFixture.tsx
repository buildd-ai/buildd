'use client';

import SpecIndex, { type AcceptSuggestion } from '@/components/SpecIndex';
import SpecNeighbourGraph from '@/components/SpecNeighbourGraph';
import { neighbourGraph } from '@/lib/specs/index-view';
import {
  SPEC_INDEX_FIXTURE_NOW, SPEC_INDEX_FIXTURE_SPECS, SPEC_INDEX_GRAPH_FIXTURE, SPEC_INDEX_NO_AREA_FIXTURE, SPEC_INDEX_ONE_AREA_FIXTURE,
} from './spec-index-fixtures';

/** Accepting a suggestion here files nothing: the fixture answers in memory. */
const acceptInMemory: AcceptSuggestion = async () => ({ ok: true });

const OPTIONS = { now: SPEC_INDEX_FIXTURE_NOW };
const NO_AREA_OPTIONS = { now: SPEC_INDEX_FIXTURE_NOW, taxonomyHref: '/app/dev/fixtures?state=spec-index' };

/**
 * The spec index (living-specs.md §19) for Visual QA: the map and outline
 * over ~30 specs in five areas with Unfiled and a possible area, then the
 * one-area and no-area lines, then the spec page's neighbour graph.
 */
export default function SpecIndexFixture() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-6" data-testid="spec-index-fixture">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-text-primary">Specs</h1>
        <SpecIndex specs={SPEC_INDEX_FIXTURE_SPECS} options={OPTIONS} accept={acceptInMemory} />
      </section>
      <section className="flex flex-col gap-3" data-testid="spec-index-fixture-one-area">
        <h2 className="section-label text-text-muted">One area</h2>
        <SpecIndex specs={SPEC_INDEX_ONE_AREA_FIXTURE} options={OPTIONS} accept={acceptInMemory} />
      </section>
      <section className="flex flex-col gap-3" data-testid="spec-index-fixture-no-area">
        <h2 className="section-label text-text-muted">No area yet</h2>
        <SpecIndex specs={SPEC_INDEX_NO_AREA_FIXTURE} options={NO_AREA_OPTIONS} accept={acceptInMemory} />
      </section>
      <section className="flex flex-col gap-3" data-testid="spec-index-fixture-graph">
        <h2 className="section-label text-text-muted">Related, as a graph</h2>
        <p className="text-meta text-text-muted md:hidden">On a phone the spec page shows its Related list instead.</p>
        <div className="hidden md:block">
          <SpecNeighbourGraph graph={neighbourGraph(SPEC_INDEX_GRAPH_FIXTURE)} />
        </div>
      </section>
    </main>
  );
}
