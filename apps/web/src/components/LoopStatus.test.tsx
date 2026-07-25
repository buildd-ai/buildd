import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoopHistory, LoopStatusChip } from './LoopStatus';
import type { LoopHistoryEntry } from '@buildd/shared';

const entry = (iteration: number, satisfied = false): LoopHistoryEntry => ({
  iteration,
  workerId: `worker-${iteration + 1}`,
  evaluatedAt: `2026-07-25T10:0${iteration}:00.000Z`,
  conditionType: 'command',
  satisfied,
  summary: satisfied ? 'Command passed' : 'Command failed',
  evidence: { durationMs: 1234 + iteration, output: `${iteration + 1} failing test` },
});

describe('LoopStatusChip', () => {
  it('renders active and deferred loop attempts distinctly', () => {
    const active = renderToStaticMarkup(
      <LoopStatusChip loopIteration={1} maxLoops={5} loopState="running" />,
    );
    const deferred = renderToStaticMarkup(
      <LoopStatusChip
        loopIteration={1}
        maxLoops={5}
        loopState="condition_unmet"
        startAt="2099-01-01T00:00:00.000Z"
      />,
    );
    expect(active).toContain('LOOPING · attempt 2/5');
    expect(active).toContain('data-loop-status="active"');
    expect(deferred).toContain('LOOPING · attempt 2/5');
    expect(deferred).toContain('resumes');
    expect(deferred).toContain('data-loop-status="deferred"');
  });

  it('caps the displayed attempt at maxLoops', () => {
    const html = renderToStaticMarkup(
      <LoopStatusChip loopIteration={8} maxLoops={5} loopState="exhausted" />,
    );
    expect(html).toContain('LOOP EXHAUSTED · 5/5');
  });
});

describe('LoopHistory', () => {
  it('renders the empty loop state', () => {
    const html = renderToStaticMarkup(<LoopHistory entries={[]} loopState="running" maxLoops={5} />);
    expect(html).toContain('No iterations evaluated yet');
  });

  it('renders one iteration with outcome, evidence excerpt, and duration', () => {
    const html = renderToStaticMarkup(
      <LoopHistory entries={[entry(0)]} loopState="condition_unmet" maxLoops={5} />,
    );
    expect(html).toContain('Iteration 1');
    expect(html).toContain('Condition unmet');
    expect(html).toContain('1 failing test');
    expect(html).toContain('1.23s');
  });

  it('renders many iterations and a clear exhausted summary', () => {
    const html = renderToStaticMarkup(
      <LoopHistory entries={[entry(0), entry(1), entry(2)]} loopState="exhausted" maxLoops={3} />,
    );
    expect(html).toContain('Condition unmet after 3 attempts');
    expect((html.match(/Iteration /g) ?? []).length).toBe(3);
  });
});
