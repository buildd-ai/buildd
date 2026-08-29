import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DependencyRail } from './DependencyRail';
import type { BlockRef } from '@/lib/task-presentation';

const ref = (id: string, title: string, prNumber?: number): BlockRef => ({
  id,
  title,
  status: 'pending',
  prUrl: prNumber ? `https://github.com/buildd-ai/buildd/pull/${prNumber}` : null,
  prNumber: prNumber ?? null,
});

const render = (props: Parameters<typeof DependencyRail>[0]) =>
  renderToStaticMarkup(<DependencyRail {...props} />);

describe('DependencyRail', () => {
  it('renders nothing with no blockers', () => {
    expect(render({ blockedBy: [] })).toBe('');
  });

  // Rule CC-1 / AC-11 — the regression this component was rewritten for.
  it('names the blocker instead of printing a 6-char hash', () => {
    const html = render({ blockedBy: [ref('afa5b0de-1111-2222-3333-444455556666', 'Sync gate specs to shipped code')] });
    expect(html).toContain('Sync gate specs to shipped code');
    // The id belongs in the href, never in a visible label.
    const labels = [...html.matchAll(/<span class="truncate">([^<]*)<\/span>/g)].map(m => m[1]);
    expect(labels).toEqual(['Sync gate specs to shipped code']);
    for (const label of labels) expect(label).not.toMatch(/^[0-9a-f]{6}$/);
  });

  it('links each chip to the blocking task', () => {
    const html = render({ blockedBy: [ref('dep-1', 'Budget Forecast UI')] });
    expect(html).toContain('href="/app/tasks/dep-1"');
  });

  it('suffixes the PR number for a half-state blocker (completed, PR open)', () => {
    const html = render({ blockedBy: [ref('dep-1', 'OAuth endpoint scaffolding', 1258)] });
    expect(html).toContain('#1258');
  });

  it('omits the PR suffix when the blocker has no PR', () => {
    const html = render({ blockedBy: [ref('dep-1', 'SPEC: deliverable uniqueness')] });
    expect(html).not.toContain('#');
  });

  it('truncates a long title rather than wrapping the row', () => {
    const long = 'DESIGN (read-only, Fable): make context inheritance for CI-fix workers actually work';
    const html = render({ blockedBy: [ref('dep-1', long)] });
    expect(html).toContain('…');
    expect(html).not.toContain(long);
  });

  // Rule CC-4
  it('names at most `max` blockers and tails the overflow', () => {
    const html = render({
      blockedBy: [ref('d1', 'First blocker'), ref('d2', 'Second blocker'), ref('d3', 'Third blocker')],
      max: 1,
    });
    expect(html).toContain('First blocker');
    expect(html).not.toContain('Second blocker');
    expect(html).toContain('+2 upstream');
  });

  it('omits the tail when every blocker is named', () => {
    const html = render({ blockedBy: [ref('d1', 'Only blocker')], totalBlocked: 1 });
    expect(html).not.toContain('upstream');
  });

  // Rule TR-1 / AC-14 — the prod shape: 6 real blockers, 1 frontier, row density.
  it('counts folded-away transitive blockers in the tail', () => {
    const html = render({
      blockedBy: [ref('e4443f', 'DESIGN: context inheritance')],
      totalBlocked: 6,
      max: 1,
    });
    expect(html).toContain('DESIGN: context inheritance');
    expect(html).toContain('+5 upstream');
  });

  it('never reports a negative tail when totalBlocked lags the named set', () => {
    const html = render({
      blockedBy: [ref('d1', 'A'), ref('d2', 'B')],
      totalBlocked: 1,
    });
    expect(html).not.toContain('upstream');
  });
});
