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

describe('LoopStatusChip on narrow viewports', () => {
  // The chip is shrink-0 beside the task title in Activity rows; the full
  // "LOOPING · attempt X/Y" label left the title a few characters at 320px.
  it('shows a compact label below md and keeps the full text for assistive tech', () => {
    const html = renderToStaticMarkup(
      <LoopStatusChip loopIteration={1} maxLoops={5} loopState="running" />,
    );
    expect(html).toMatch(/<span[^>]*class="[^"]*md:hidden[^"]*"[^>]*aria-hidden="true"[^>]*>LOOP 2\/5<\/span>/);
    expect(html).toMatch(/<span[^>]*class="[^"]*hidden md:inline[^"]*"[^>]*aria-hidden="true"[^>]*>LOOPING · attempt 2\/5<\/span>/);
    expect(html).toMatch(/<span class="sr-only">LOOPING · attempt 2\/5<\/span>/);
  });

  it('drops the deferred resume time from the compact label but keeps it at md+', () => {
    const html = renderToStaticMarkup(
      <LoopStatusChip
        loopIteration={1}
        maxLoops={5}
        loopState="condition_unmet"
        startAt="2099-01-01T00:00:00.000Z"
      />,
    );
    const compact = html.match(/<span[^>]*md:hidden[^>]*>([^<]*)<\/span>/)?.[1];
    expect(compact).toBe('LOOP 2/5');
    expect(html).toMatch(/hidden md:inline[^>]*>[^<]*<span[^>]*> · resumes/);
  });
});

describe('LoopHistory', () => {
  it('renders the empty loop state', () => {
    const html = renderToStaticMarkup(<LoopHistory entries={[]} loopState="running" maxLoops={5} />);
    expect(html).toContain('No iterations evaluated.');
  });

  it('renders one iteration with outcome, evidence excerpt, and duration', () => {
    const html = renderToStaticMarkup(
      <LoopHistory entries={[entry(0)]} loopState="condition_unmet" maxLoops={5} />,
    );
    expect(html).toContain('Iteration 1');
    expect(html).toContain('Check failed');
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

describe('Loop chip and history agree (surface fix 415f718a)', () => {
  // A task satisfied on its 2nd evaluation stores loopIteration=2 (evaluations
  // completed). The chip used to add one for "the attempt in progress" even
  // when nothing was in progress, so it read 3/3 over a 2-row history.
  const uuid = '00000000-0000-4000-8000-000000000001';
  const ciEntry = (iteration: number, satisfied: boolean): LoopHistoryEntry => ({
    iteration,
    workerId: uuid,
    evaluatedAt: `2026-07-25T10:0${iteration}:00.000Z`,
    conditionType: 'pr_checks_green',
    satisfied,
    summary: satisfied ? 'Checks green' : 'Checks failing',
  });

  it('counts the same number of iterations in the chip and the list', () => {
    const entries = [ciEntry(0, false), ciEntry(1, true)];
    const chip = renderToStaticMarkup(
      <LoopStatusChip loopIteration={2} maxLoops={3} loopState="satisfied" exitConditionType="pr_checks_green" />,
    );
    const list = renderToStaticMarkup(<LoopHistory entries={entries} loopState="satisfied" maxLoops={3} />);
    expect(chip).toContain('LOOP SATISFIED · 2/3');
    expect((list.match(/Iteration \d/g) ?? []).length).toBe(2);
  });

  it('counts evaluations on an exhausted loop', () => {
    const chip = renderToStaticMarkup(
      <LoopStatusChip loopIteration={3} maxLoops={3} loopState="exhausted" />,
    );
    expect(chip).toContain('LOOP EXHAUSTED · 3/3');
  });

  it('renders no worker UUID and no raw condition enum', () => {
    const list = renderToStaticMarkup(
      <LoopHistory entries={[ciEntry(0, false), ciEntry(1, true)]} loopState="satisfied" maxLoops={3} />,
    );
    expect(list).not.toContain(uuid);
    expect(list).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(list).not.toContain('pr_checks_green');
    expect(list).not.toMatch(/PR_CHECKS_GREEN/i);
    expect(list).toContain('until CI passes');
    expect(list).toContain('CI passed');
    expect(list).toContain('CI not passing');
  });
});
