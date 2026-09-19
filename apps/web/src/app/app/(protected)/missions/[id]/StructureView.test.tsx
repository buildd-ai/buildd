/**
 * Structure canvas — docs/specs/mission-legibility.md §4.7 (Rule R4-21/R4-22).
 * The canvas renders the same work-kind glyph the rail does, from
 * `deriveWorkKind` and nothing else, and draws NO phase swimlane, band, or
 * label — explicitly nothing, not "later" (AC-19).
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import StructureView from './StructureView';
import type { StructureTask } from '@/lib/structure-layout';
import type { CondensedTask, ChainUnit } from '@/lib/condensed-timeline';

function makeTask(id: string, overrides: Partial<StructureTask> = {}): StructureTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'pending',
    roleColor: '#8A8478',
    latestWorker: null,
    ...overrides,
  };
}

function makeCondensedTask(id: string, overrides: Partial<CondensedTask> = {}): CondensedTask {
  return { id, status: 'pending', dependsOn: null, workers: [], ...overrides };
}

function chainOf(head: StructureTask, tail: StructureTask[] = []): ChainUnit<StructureTask> {
  return { head, tail, shape: tail.length ? 'linear' : 'standalone' };
}

function taskMap(...tasks: CondensedTask[]): Map<string, CondensedTask> {
  return new Map(tasks.map(t => [t.id, t]));
}

describe('StructureView — work-kind glyph (Rule R4-21)', () => {
  it('renders the glyph for a node whose head has a declared kind', () => {
    const head = makeTask('a', { kind: 'engineering' });
    const html = renderToStaticMarkup(
      <StructureView chains={[chainOf(head)]} taskMap={taskMap(makeCondensedTask('a'))} missionId="m1" />,
    );
    expect(html).toContain('◆');
  });

  it('renders no glyph for a task with nothing set — no title-derived fallback (AC-9 parity)', () => {
    const head = makeTask('a', { title: 'BUILD: rewrite the claim loop' });
    const html = renderToStaticMarkup(
      <StructureView chains={[chainOf(head)]} taskMap={taskMap(makeCondensedTask('a'))} missionId="m1" />,
    );
    expect(html).not.toContain('◆');
  });
});

describe('StructureView — no phase swimlanes (Rule R4-22, AC-19)', () => {
  it('renders no swimlane band or phase label — StructureTask carries no phase field to draw one from', () => {
    // R4-22's enforcement is structural: StructureTask has no missionPhaseIndex/
    // Label field at all, so there is nothing for this canvas to read a band
    // from even for a mission the rail would draw four headers for.
    const a = makeTask('a');
    const b = makeTask('b');
    const html = renderToStaticMarkup(
      <StructureView
        chains={[chainOf(a), chainOf(b)]}
        taskMap={taskMap(makeCondensedTask('a'), makeCondensedTask('b'))}
        missionId="m1"
      />,
    );
    expect(html).not.toContain('swimlane');
    expect(html).not.toContain('data-testid="phase-band"');
  });
});
