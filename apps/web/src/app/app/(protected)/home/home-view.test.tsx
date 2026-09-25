/**
 * Pure view logic behind /app/home — counts, grouping and empty states that
 * the page renders. Fixtures are illustrative.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActionQueueItem } from '@/lib/action-queue';
import type { Stage } from '@/lib/stage';
import { StageChip } from '@/components/StageChip';
import {
  splitWaitingOnYou,
  waitingOnYouSummary,
  rightNowState,
  stripLeadingPrRef,
  stageChipShowsPrNumber,
  recordBestEffort,
  homeSubheading,
} from './home-view';

const item = (chip: ActionQueueItem['chip'], key: string) => ({ chip, subjectKey: key }) as ActionQueueItem;

describe('splitWaitingOnYou — the count and the cards agree', () => {
  // One card needs the human; four are an agent's to finish. The badge used
  // to say "1" over a list of five cards with no way to tell which one.
  const queue = [
    item('DISCREPANCY', 'd1'),
    item('CI_RUNNING', 'c1'),
    item('FIXING_SPEC', 'f1'),
    item('RESOLVING', 'r1'),
    item('FIXING_CI', 'x1'),
  ];

  it('puts only human-actionable chips in needsYou, agent-handled ones in inFlight', () => {
    const { needsYou, inFlight } = splitWaitingOnYou(queue);
    expect(needsYou.map(i => i.subjectKey)).toEqual(['d1']);
    expect(inFlight.map(i => i.subjectKey)).toEqual(['c1', 'f1', 'r1', 'x1']);
  });

  it('keeps queue order within each group and loses nothing', () => {
    const mixed = [item('CI_RUNNING', 'c1'), item('MERGE', 'm1'), item('RESOLVING', 'r1'), item('QUESTION', 'q1')];
    const { needsYou, inFlight } = splitWaitingOnYou(mixed);
    expect(needsYou.map(i => i.subjectKey)).toEqual(['m1', 'q1']);
    expect(inFlight.map(i => i.subjectKey)).toEqual(['c1', 'r1']);
    expect(needsYou.length + inFlight.length).toBe(mixed.length);
  });

  it('summary names both halves, and never calls in-flight work "waiting on you"', () => {
    expect(waitingOnYouSummary(1, 4)).toBe('1 needs you · 4 in flight');
    expect(waitingOnYouSummary(2, 0)).toBe('2 need you');
    expect(waitingOnYouSummary(0, 3)).toBe('3 in flight');
    expect(waitingOnYouSummary(0, 0)).toBeNull();
  });
});

describe('homeSubheading — the greeting and the Waiting-on-You header say the same thing', () => {
  it('uses the header\'s "needs you" wording and count', () => {
    expect(homeSubheading('3 ships today', 1)).toBe('3 ships today · 1 needs you');
    expect(homeSubheading(null, 2)).toBe('2 need you');
    expect(homeSubheading('1 ship overnight', 0)).toBe('1 ship overnight');
    expect(homeSubheading(null, 0)).toBe('Your agents are standing by');
  });

  it('matches the header summary for the same (initiative-filtered) queue', () => {
    const filtered = [item('MERGE', 'm1'), item('CI_RUNNING', 'c1')];
    const { needsYou } = splitWaitingOnYou(filtered);
    expect(homeSubheading(null, needsYou.length)).toBe(waitingOnYouSummary(needsYou.length, 0));
  });
});

describe('rightNowState — the empty state follows the real workspace set', () => {
  it('a team with workspaces and nothing running is idle, not "create a workspace"', () => {
    expect(rightNowState({ inFlightCount: 0, workspaceCount: 3, totalTaskCount: 40 })).toBe('idle');
  });
  it('only a team with no workspaces is asked to connect a repo', () => {
    expect(rightNowState({ inFlightCount: 0, workspaceCount: 0, totalTaskCount: 0 })).toBe('create-workspace');
  });
  it('workspaces but no tasks yet → get started', () => {
    expect(rightNowState({ inFlightCount: 0, workspaceCount: 1, totalTaskCount: 0 })).toBe('get-started');
  });
  it('anything in flight → active', () => {
    expect(rightNowState({ inFlightCount: 2, workspaceCount: 0, totalTaskCount: 0 })).toBe('active');
  });
});

describe('stripLeadingPrRef — the #N chip already says it', () => {
  it('drops a leading "PR #N:" matching the chip', () => {
    expect(stripLeadingPrRef('PR #42: Fix the claim loop', 42)).toBe('Fix the claim loop');
    expect(stripLeadingPrRef('PR #42 — Fix the claim loop', 42)).toBe('Fix the claim loop');
    expect(stripLeadingPrRef('#42: Fix the claim loop', 42)).toBe('Fix the claim loop');
  });
  it('leaves the title alone when the number differs, is absent, or would empty it', () => {
    expect(stripLeadingPrRef('PR #41: Fix the claim loop', 42)).toBe('PR #41: Fix the claim loop');
    expect(stripLeadingPrRef('PR #42: Fix the claim loop', null)).toBe('PR #42: Fix the claim loop');
    expect(stripLeadingPrRef('Mentions PR #42: later', 42)).toBe('Mentions PR #42: later');
    expect(stripLeadingPrRef('PR #42:', 42)).toBe('PR #42:');
  });
  it('stageChipShowsPrNumber matches what StageChip actually renders, for every stage', () => {
    const stages: Stage[] = [
      'SUBJECT_DEAD', 'MISSION_BUDGET', 'BLOCKED', 'QUEUED', 'RUNNING', 'WAITING_INPUT', 'REVIEWING',
      'OPEN', 'CI', 'CI_FAILING', 'MERGE', 'VERIFY', 'DONE', 'FAILED', 'CANCELLED',
    ];
    for (const stage of stages) {
      const html = renderToStaticMarkup(<StageChip stage={stage} prNumber={4242} />);
      expect({ stage, shows: stageChipShowsPrNumber(stage) }).toEqual({ stage, shows: html.includes('#4242') });
    }
  });
});

describe('recordBestEffort — a failing render-time write never blanks Home', () => {
  it('defers the write to the scheduler and swallows its failure', async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const onError = mock(() => {});
    const write = mock(() => { throw new Error('[DISABLE_WRITES] Mutation blocked'); });
    // Does not throw synchronously — the page's render keeps going.
    expect(() => recordBestEffort('seen', write, { schedule: (fn) => { scheduled.push(fn); }, onError })).not.toThrow();
    expect(write).not.toHaveBeenCalled();
    await scheduled[0]!();
    expect(write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a rejected write is caught too', async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const onError = mock(() => {});
    recordBestEffort('seen', () => Promise.reject(new Error('conn reset')), { schedule: (fn) => { scheduled.push(fn); }, onError });
    await expect(scheduled[0]!()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('runs inline, still caught, when no request scope exists for after()', async () => {
    const onError = mock(() => {});
    let ran = false;
    recordBestEffort('seen', async () => { ran = true; throw new Error('boom'); }, {
      schedule: () => { throw new Error('after() called outside a request scope'); },
      onError,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
