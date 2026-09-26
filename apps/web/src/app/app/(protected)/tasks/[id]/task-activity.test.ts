import { describe, test, expect } from 'bun:test';
import {
  classifyAction,
  touchedFiles,
  buildTape,
  deriveNow,
  formatOffset,
  countToolCalls,
  diffSegments,
} from './task-activity';

const T0 = 1_000_000;

describe('classifyAction', () => {
  test('uses structured tool fields when present', () => {
    expect(classifyAction({ type: 'action', label: 'Edited a.ts', ts: T0, tool: 'Edit', path: 'src/a.ts', add: 3, rem: 1 }))
      .toEqual({ kind: 'edit', path: 'src/a.ts', add: 3, rem: 1, count: 1 });
    expect(classifyAction({ type: 'action', label: 'Wrote b.ts', ts: T0, tool: 'Write', path: 'src/b.ts', add: 10 }))
      .toEqual({ kind: 'new', path: 'src/b.ts', add: 10, rem: 0, count: 1 });
    expect(classifyAction({ type: 'action', label: 'Edited c.ts', ts: T0, tool: 'MultiEdit', path: 'c.ts', add: 2, rem: 2 })?.kind).toBe('edit');
    expect(classifyAction({ type: 'action', label: 'Read d.ts', ts: T0, tool: 'Read', path: 'd.ts', count: 3 }))
      .toEqual({ kind: 'read', path: 'd.ts', add: 0, rem: 0, count: 3 });
    expect(classifyAction({ type: 'action', label: 'Ran: bun test', ts: T0, tool: 'Bash', cmd: 'bun test' }))
      .toEqual({ kind: 'run', cmd: 'bun test', add: 0, rem: 0, count: 1 });
  });

  test('degrades to parsing the legacy label when structured data is absent', () => {
    expect(classifyAction({ type: 'action', label: 'Edited invoice.tsx', ts: T0 }))
      .toEqual({ kind: 'edit', path: 'invoice.tsx', add: null, rem: null, count: 1 });
    expect(classifyAction({ type: 'action', label: 'Wrote Footnote.tsx', ts: T0 })?.kind).toBe('new');
    expect(classifyAction({ type: 'action', label: 'Ran: bun test', ts: T0 }))
      .toEqual({ kind: 'run', cmd: 'bun test', add: null, rem: null, count: 1 });
  });

  test('returns null for non-actions and unparseable labels', () => {
    expect(classifyAction({ type: 'status', label: 'Edited x', ts: T0 })).toBeNull();
    expect(classifyAction({ type: 'action', ts: T0 })).toBeNull();
    expect(classifyAction({ type: 'action', label: 'Something else', ts: T0 })).toBeNull();
  });
});

describe('touchedFiles', () => {
  test('aggregates edits per path, newest first, and keeps new-file glyph', () => {
    const { rows, reads } = touchedFiles([
      { type: 'action', label: 'Wrote F.tsx', ts: T0 + 1, tool: 'Write', path: 'pkg/F.tsx', add: 30 },
      { type: 'action', label: 'Edited F.tsx', ts: T0 + 5, tool: 'Edit', path: 'pkg/F.tsx', add: 12, rem: 0 },
      { type: 'action', label: 'Edited i.tsx', ts: T0 + 3, tool: 'Edit', path: 'pkg/i.tsx', add: 31, rem: 6 },
      { type: 'action', label: 'Read m.ts', ts: T0 + 2, tool: 'Read', path: 'm.ts' },
      { type: 'action', label: 'Read m.ts', ts: T0 + 4, tool: 'Read', path: 'm.ts' },
      { type: 'action', label: 'Ran: bun test', ts: T0 + 6, tool: 'Bash', cmd: 'bun test' },
    ]);
    expect(rows.map(r => [r.kind, r.path ?? r.cmd])).toEqual([
      ['run', 'bun test'],
      ['new', 'pkg/F.tsx'],
      ['edit', 'pkg/i.tsx'],
    ]);
    expect(rows[1]).toMatchObject({ add: 42, rem: 0, lastTs: T0 + 5 });
    expect(reads).toEqual([{ kind: 'read', path: 'm.ts', add: 0, rem: 0, lastTs: T0 + 4, count: 2 }]);
  });

  test('legacy rows have unknown line counts (null), not zero', () => {
    const { rows } = touchedFiles([{ type: 'action', label: 'Edited a.ts', ts: T0 }]);
    expect(rows[0]).toMatchObject({ path: 'a.ts', add: null, rem: null });
  });
});

describe('countToolCalls', () => {
  test('uses the larger of phase tool counts and action entries (compacted reads count)', () => {
    expect(countToolCalls([
      { type: 'phase', label: 'p', toolCount: 4, ts: T0 },
      { type: 'action', label: 'Read a', tool: 'Read', path: 'a', count: 3, ts: T0 },
      { type: 'action', label: 'Edited b', ts: T0 },
    ])).toBe(4);
    expect(countToolCalls([
      { type: 'action', label: 'Read a', tool: 'Read', path: 'a', count: 3, ts: T0 },
      { type: 'action', label: 'Edited b', ts: T0 },
    ])).toBe(4);
  });
});

describe('buildTape', () => {
  test('places ticks and progress flags on a 0..1 axis from start to now', () => {
    const tape = buildTape(
      [
        { type: 'action', label: 'Read a', tool: 'Read', path: 'a', ts: T0 + 25_000 },
        { type: 'action', label: 'Edited b', ts: T0 + 75_000 },
        { type: 'status', label: 'Halfway', progress: 50, ts: T0 + 50_000 },
        { type: 'status', label: 'No pct', ts: T0 + 60_000 },
      ],
      { startMs: T0, nowMs: T0 + 100_000 },
    );
    expect(tape.ticks).toEqual([
      { pos: 0.25, kind: 'read', label: 'Read a' },
      { pos: 0.75, kind: 'edit', label: 'Edited b' },
    ]);
    expect(tape.flags).toEqual([{ pos: 0.5, pct: 50, label: 'Halfway', at: '0:50' }]);
    expect(tape.axis).toEqual(['0:00', '0:25', '0:50', '1:15']);
  });

  test('clamps out-of-range timestamps', () => {
    const tape = buildTape([{ type: 'action', label: 'Edited b', ts: T0 - 5 }], { startMs: T0, nowMs: T0 + 10 });
    expect(tape.ticks[0].pos).toBe(0);
  });
});

describe('formatOffset', () => {
  test('m:ss and h:mm:ss', () => {
    expect(formatOffset(0)).toBe('0:00');
    expect(formatOffset(261_000)).toBe('4:21');
    expect(formatOffset(3_725_000)).toBe('1:02:05');
  });
});

describe('deriveNow', () => {
  const ms = [
    { type: 'checkpoint' as const, event: 'session_started', label: 'Session started', ts: T0 },
    { type: 'checkpoint' as const, event: 'first_read', label: 'First file read', ts: T0 + 4_000 },
    { type: 'status' as const, label: 'Invoice page reads presentment amounts', progress: 20, ts: T0 + 76_000 },
    { type: 'checkpoint' as const, event: 'first_edit', label: 'First edit', ts: T0 + 200_000 },
    { type: 'status' as const, label: 'PDF footnote: base amount and the rate used', progress: 45, ts: T0 + 221_000 },
    { type: 'action' as const, label: 'Wrote Footnote.tsx', tool: 'Write' as const, path: 'pkg/Footnote.tsx', ts: T0 + 240_000 },
    { type: 'action' as const, label: 'Edited Footnote.tsx', tool: 'Edit' as const, path: 'pkg/Footnote.tsx', ts: T0 + 250_000 },
  ];

  test('headline is the latest progress message, pct its progress, detail the latest file action', () => {
    const now = deriveNow(ms, { status: 'running', currentAction: 'Editing /w/pkg/Footnote.tsx', prUrl: null, startMs: T0, nowMs: T0 + 261_000 });
    expect(now.headline).toBe('PDF footnote: base amount and the rate used');
    expect(now.pct).toBe(45);
    expect(now.detail).toEqual({ verb: 'Writing', target: 'Footnote.tsx', recentEdits: 2 });
    expect(now.updatedTs).toBe(T0 + 250_000);
  });

  test('step rail marks done steps with their offset and the first missing one current', () => {
    const now = deriveNow(ms, { status: 'running', currentAction: null, prUrl: null, startMs: T0, nowMs: T0 + 261_000 });
    expect(now.steps.map(s => [s.key, s.state, s.at])).toEqual([
      ['started', 'done', '0:00'],
      ['read', 'done', '0:04'],
      ['edit', 'done', '3:20'],
      ['commit', 'current', null],
      ['pr', 'todo', null],
      ['done', 'todo', null],
    ]);
  });

  test('PR step is done when the worker has a PR url; done step when completed', () => {
    const now = deriveNow(
      [...ms, { type: 'status', label: 'Commit: x', ts: T0 + 300_000 }, { type: 'checkpoint', event: 'task_completed', label: 'Task completed', ts: T0 + 400_000 }],
      { status: 'completed', currentAction: null, prUrl: 'https://example.test/pr/1', startMs: T0, nowMs: T0 + 400_000 },
    );
    expect(now.steps.map(s => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
  });

  test('falls back to currentAction when no progress message exists', () => {
    const now = deriveNow([], { status: 'running', currentAction: 'Reading /x/y.ts', prUrl: null, startMs: T0, nowMs: T0 + 1 });
    expect(now.headline).toBe('Reading /x/y.ts');
    expect(now.pct).toBeNull();
    expect(now.steps[0].state).toBe('current');
  });

  test('ignores question/answer bookkeeping when picking the headline', () => {
    const now = deriveNow(
      [...ms, { type: 'status', label: 'Asked: Round per line?', ts: T0 + 260_000 }],
      { status: 'waiting_input', currentAction: null, prUrl: null, startMs: T0, nowMs: T0 + 261_000 },
    );
    expect(now.headline).toBe('PDF footnote: base amount and the rate used');
  });
});

describe('diffSegments', () => {
  test('splits a diff bar into proportional add/remove segments per attempt', () => {
    expect(diffSegments([{ add: 300, rem: 100 }, { add: 80, rem: 20 }])).toEqual([
      { attempt: 0, kind: 'add', frac: 0.6 },
      { attempt: 0, kind: 'rem', frac: 0.2 },
      { attempt: 1, kind: 'add', frac: 0.16 },
      { attempt: 1, kind: 'rem', frac: 0.04 },
    ]);
  });

  test('empty when nothing changed', () => {
    expect(diffSegments([{ add: 0, rem: 0 }])).toEqual([]);
  });
});
