import { describe, test, expect } from 'bun:test';
import type { WorkerMilestone } from '@buildd/core/db/schema';
import {
  isNarrationMilestone,
  formatDurationShort,
  milestoneDurationLabel,
  buildMilestoneLog,
  showTokenCount,
} from './milestone-log';

describe('isNarrationMilestone', () => {
  test.each([
    "Now I'll run the tests",
    'Let me check the schema',
    "I'll add the route",
    'I will update the types',
    'Next, I update the docs',
    'Next I wire the handler',
    'Now let me look at the failing test',
    "I'm going to refactor this",
    "Let's see what broke",
    '  now i\'ll trim first  ',
    'LET ME SHOUT',
    'Now I’ll use a curly apostrophe',
  ])('narration: %s', (text) => {
    expect(isNarrationMilestone(text)).toBe(true);
  });

  test.each([
    'Tests pass',
    'Opened PR #12',
    'Commit: fix the footnote',
    'Letter template updated',
    'Illustrations regenerated',
    'Nowcast model fixed',
    'Typecheck clean',
    '',
  ])('outcome: %s', (text) => {
    expect(isNarrationMilestone(text)).toBe(false);
  });
});

describe('formatDurationShort / milestoneDurationLabel', () => {
  test('under a minute is seconds', () => {
    expect(formatDurationShort(42_000)).toBe('42s');
    expect(formatDurationShort(0)).toBe('0s');
    expect(formatDurationShort(-5)).toBe('0s');
  });
  test('minutes', () => {
    expect(formatDurationShort(3 * 60_000 + 20_000)).toBe('3m');
  });
  test('hours and minutes', () => {
    expect(formatDurationShort(65 * 60_000)).toBe('1h 5m');
    expect(formatDurationShort(120 * 60_000)).toBe('2h');
  });
  test('a finished entry shows its duration', () => {
    expect(milestoneDurationLabel(1_000, 43_000, 999_999)).toBe('42s');
  });
  test('the open entry shows how long it has been running', () => {
    expect(milestoneDurationLabel(0, null, 3 * 60_000 + 5_000)).toBe('running 3m');
  });
});

describe('buildMilestoneLog', () => {
  const T0 = 1_000_000;
  const ms: WorkerMilestone[] = [
    { type: 'checkpoint', event: 'session_started', label: 'Session started', ts: T0 },
    { type: 'action', label: 'Read a.ts', tool: 'Read', path: 'a.ts', ts: T0 + 5_000 },
    { type: 'status', label: "Now I'll run the tests", ts: T0 + 10_000 },
    { type: 'action', label: 'Ran: bun test', tool: 'Bash', cmd: 'bun test', ts: T0 + 12_000 },
    { type: 'status', label: 'Tests pass', ts: T0 + 20_000 },
    { type: 'action', label: 'Edited b.ts', tool: 'Edit', path: 'b.ts', ts: T0 + 25_000 },
    { type: 'action', label: 'Ran: bun run typecheck', ts: T0 + 30_000 },
    { type: 'status', label: 'Typecheck clean', ts: T0 + 62_000 },
  ];

  test('drops narration and tool rows from the entries, newest first', () => {
    const log = buildMilestoneLog(ms, { nowMs: T0 + 242_000, live: true });
    expect(log.map(e => e.milestone.label)).toEqual(['Typecheck clean', 'Tests pass', 'Session started']);
  });

  test('tool calls hang under the milestone they happened in; narration folds into the previous one', () => {
    const log = buildMilestoneLog(ms, { nowMs: T0 + 242_000, live: true });
    const [typecheck, tests, started] = log;
    expect(started.tools.map(t => t.label)).toEqual(['Read a.ts', 'Ran: bun test']);
    expect(started.toolCount).toBe(2);
    expect(tests.tools.map(t => t.label)).toEqual(['Edited b.ts', 'Ran: bun run typecheck']);
    expect(typecheck.tools).toEqual([]);
  });

  test('finished entries show their duration; the newest live entry shows running', () => {
    const log = buildMilestoneLog(ms, { nowMs: T0 + 242_000, live: true });
    expect(log.map(e => e.durationLabel)).toEqual(['running 3m', '42s', '20s']);
    expect(log[0].endMs).toBeNull();
  });

  test('a finished run does not claim its last entry is running', () => {
    const log = buildMilestoneLog(ms, { nowMs: T0 + 999_000, live: false });
    expect(log[0].durationLabel).toBeNull();
    expect(log[1].durationLabel).toBe('42s');
  });

  test('a narration phase gives its tool count to the entry before it', () => {
    const log = buildMilestoneLog([
      { type: 'phase', label: 'Found the cause in the parser', toolCount: 3, ts: T0 },
      { type: 'phase', label: 'Let me fix it', toolCount: 4, ts: T0 + 10_000 },
      { type: 'phase', label: 'Fix applied', toolCount: 1, ts: T0 + 20_000 },
    ], { nowMs: T0 + 30_000, live: true });
    expect(log.map(e => [e.milestone.label, e.toolCount])).toEqual([['Fix applied', 1], ['Found the cause in the parser', 7]]);
  });

  test('tool calls before the first milestone are kept under it', () => {
    const log = buildMilestoneLog([
      { type: 'action', label: 'Read x.ts', ts: T0 },
      { type: 'status', label: 'Plan ready', ts: T0 + 1_000 },
    ], { nowMs: T0 + 2_000, live: true });
    expect(log).toHaveLength(1);
    expect(log[0].tools).toHaveLength(1);
  });

  test('only tool calls means no entries', () => {
    expect(buildMilestoneLog([{ type: 'action', label: 'Read x.ts', ts: T0 }], { nowMs: T0, live: true })).toEqual([]);
  });
});

describe('buildMilestoneLog — tool-call preambles', () => {
  const T0 = 2_000_000;

  test('text + tool call in the same turn collapses to one tool-derived entry', () => {
    const log = buildMilestoneLog([
      { type: 'phase', label: 'Now let me check the decision', toolCount: 1, ops: ['get_decision'], ts: T0 },
    ], { nowMs: T0 + 5_000, live: true });
    expect(log).toHaveLength(1);
    expect(log[0].actionLabel).toBe('Checked decision');
    // The raw text is kept, on the entry and on the milestone itself.
    expect(log[0].preambles).toEqual(['Now let me check the decision']);
    expect(log[0].milestone.label).toBe('Now let me check the decision');
    expect(log[0].toolCount).toBe(1);
  });

  test('adjacent phases that did the same thing merge into one entry', () => {
    const log = buildMilestoneLog([
      { type: 'phase', label: 'Now let me save a knowledge entry', toolCount: 1, ops: ['learn'], ts: T0 },
      { type: 'phase', label: 'And one more for the gotcha', toolCount: 1, ops: ['learn'], ts: T0 + 1_000 },
    ], { nowMs: T0 + 5_000, live: false });
    expect(log.map(e => e.actionLabel)).toEqual(['Saved knowledge']);
    expect(log[0].preambles).toHaveLength(2);
    expect(log[0].toolCount).toBe(2);
  });

  test('substantive prose followed by a tool call stays as written', () => {
    const label = 'Found the cause: the claim route does not filter by role';
    const log = buildMilestoneLog([
      { type: 'phase', label, toolCount: 2, ops: ['Edit'], ts: T0 },
    ], { nowMs: T0 + 5_000, live: true });
    expect(log[0].actionLabel).toBeUndefined();
    expect(log[0].milestone.label).toBe(label);
  });

  test('narration that carries a finding is no longer dropped', () => {
    const log = buildMilestoneLog([
      { type: 'status', label: "Let me fix it — the fixture is stale because the seed changed", ts: T0 },
    ], { nowMs: T0 + 5_000, live: true });
    expect(log).toHaveLength(1);
  });

  test('an older runner (no ops) keeps the lexical narration fallback', () => {
    const log = buildMilestoneLog([
      { type: 'phase', label: 'Tests pass', toolCount: 1, ts: T0 },
      { type: 'phase', label: 'Now let me open the PR', toolCount: 2, ts: T0 + 1_000 },
    ], { nowMs: T0 + 5_000, live: true });
    expect(log.map(e => e.milestone.label)).toEqual(['Tests pass']);
    expect(log[0].toolCount).toBe(3);
  });

  test('order and timing are preserved around tool-derived entries', () => {
    const log = buildMilestoneLog([
      { type: 'status', label: 'Plan ready', ts: T0 },
      { type: 'phase', label: 'Let me get error traces', toolCount: 1, ops: ['get_error_traces'], ts: T0 + 10_000 },
      { type: 'status', label: 'Root cause found', ts: T0 + 25_000 },
    ], { nowMs: T0 + 30_000, live: false });
    expect(log.map(e => e.actionLabel ?? e.milestone.label)).toEqual(['Root cause found', 'Checked error traces', 'Plan ready']);
    expect(log[1].durationLabel).toBe('15s');
  });
});

describe('showTokenCount', () => {
  test('a real count shows', () => {
    expect(showTokenCount(1200, 4)).toBe(true);
  });
  test('zero tokens after turns is a reporting gap and hides', () => {
    expect(showTokenCount(0, 3)).toBe(false);
    expect(showTokenCount(null, 3)).toBe(false);
  });
  test('zero before any turn is honest', () => {
    expect(showTokenCount(0, 0)).toBe(true);
  });
});
