/**
 * The Queue tells the truth about slots and refusals (spec c7410e76 R-26,
 * R-43..R-45, AC-27, AC-30), and the header says what the claim loop did
 * (task 9e12f377 part 3). The queue is shaped like a live runner's
 * GET /api/queue answer and its claim outcomes like the server's claim
 * diagnostics; titles and ids are made up.
 *
 * The owner's case: 9 slots, 1 running, a task the server refused thousands of
 * times with soft_overlap read "next", and the rows behind it "after 1, after 2".
 */
import { describe, expect, test } from 'bun:test';
import type { RunnerQueueResponse, RunnerQueueTask } from '@buildd/shared';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { handleKey, actionResultText } from '../../src/top/keys';
import { queueSections, slotsSummary } from '../../src/top/queue';
import { renderFrame, textWidth } from '../../src/top/render';
import { claimLoopLine, initialState, reduce, type TopState, type TopWorker } from '../../src/top/state';
import { frameOnce } from '../../src/top/frame';
import type { SocketClient } from '../../src/top/client';

/** 2026-03-10 15:00 local time. */
const NOW = new Date(2026, 2, 10, 15, 0, 0).getTime();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const plain = createPalette('night', 'none');
const text = (lines: string[]) => lines.map(l => stripAnsi(l)).join('\n');

const SOFT = (holder: string) => `Its declared scope overlaps in-flight task ${holder} on apps/runner/src/runner-hold.ts, apps/runner/__tests__/unit/**, and the hold/start decision said HOLD. It starts when that task finishes or a START is decided. An admin can claim it anyway with claim_task force: true.`;

const task = (over: Partial<RunnerQueueTask> & { id: string; title: string }): RunnerQueueTask => ({
  workspaceId: 'ws-main', workspaceName: 'buildd', missionId: null, missionTitle: null, roleSlug: 'builder', backend: 'claude',
  priority: 8, createdAt: iso(NOW - 3_600_000), dependsOn: [], holds: [], holdUntil: null, holdCause: null, estimateMinutes: null,
  ...over,
});

const QUEUE: RunnerQueueResponse = {
  truncated: false,
  teams: [{
    teamId: 'team-b', teamName: 'Buildd', estimatesOn: true,
    queue: [
      task({ id: 'a0a0a0a0-0001', title: 'feat(runner): top says why nothing started', estimateMinutes: 13 }),
      task({ id: 'a0a0a0a0-0002', title: 'feat: recovery page, impact-ranked queue', workspaceId: 'ws-admin', workspaceName: 'acme-portal' }),
      task({ id: 'a0a0a0a0-0003', title: 'test: operator recovery end to end', workspaceId: 'ws-admin', workspaceName: 'acme-portal' }),
      task({ id: 'a0a0a0a0-0004', title: 'fix(runner): hold --for ceiling', missionId: 'm-rt', missionTitle: 'Runner terminal', estimateMinutes: 9 }),
      task({ id: 'a0a0a0a0-0005', title: 'refactor(schema): drop incident tables', missionId: 'm-rc', missionTitle: 'Root causes', dependsOn: ['b0b0b0b0-dep'], holds: ['deps_blocked'], estimateMinutes: 14 }),
      task({ id: 'a0a0a0a0-0006', title: 'feat(insights): estimation dashboard', workspaceId: 'ws-admin', workspaceName: 'acme-portal', estimateMinutes: 7 }),
      task({ id: 'a0a0a0a0-0007', title: 'fix(ci): dev is red', backend: 'codex', holds: ['deferred'], holdUntil: iso(NOW + 26 * 3_600_000), holdCause: 'credential_probe' }),
    ],
    notForRunner: [],
  }],
};

/** A runner with `slots` slots, `running` agents working, and the queue above read. */
function stateWith(slots: number, running: number, over: Partial<TopState> = {}): TopState {
  let s = initialState({ hostname: 'atlas' });
  s = reduce(s, { type: 'runner', pid: 1, version: '0.358.1' });
  s = reduce(s, { type: 'config', maxConcurrent: slots, builddServer: 'https://buildd.dev' });
  s = reduce(s, { type: 'workspaces', workspaces: [
    { id: 'ws-main', name: 'buildd', teamId: 'team-b', teamName: 'Buildd' },
    { id: 'ws-admin', name: 'acme-portal', teamId: 'team-b', teamName: 'Buildd' },
  ] });
  const workers: TopWorker[] = Array.from({ length: running }, (_, i) => ({
    id: `w-run-${i}`, taskId: `c0c0c0c0-0${i}`, taskTitle: `running work ${i + 1}`, status: 'working', startedAt: NOW - (10 + i) * MIN, currentAction: 'Edit a.ts',
  }));
  s = reduce(s, { type: 'workers', workers });
  s = reduce(s, { type: 'tasks', tasks: workers.map(w => ({ id: w.taskId, title: w.taskTitle!, status: 'in_progress' })) });
  s = reduce(s, { type: 'queue', queue: QUEUE });
  s = reduce(s, { type: 'connection', online: true });
  return { ...s, view: 'queue', ...over };
}

const refusedOverlap = (s: TopState, taskId: string, holder: string, withField = true): TopState => reduce(s, {
  type: 'claim_outcome', taskId,
  outcome: { at: NOW - 20_000, reason: 'all_candidates_deferred', exclusion: 'soft_overlap', detail: SOFT(holder), ...(withField ? { holderTaskId: holder } : {}) },
});

const starts = (s: TopState) => queueSections(s, NOW)[0].rows.map(r => [r.position, r.starts]);

describe('free slots start rows now, several at once (R-26, AC-27)', () => {
  test('8 of 9 free: every row nothing holds reads "now"; none reads "next" or "after N"', () => {
    const s = stateWith(9, 1);
    expect(starts(s)).toEqual([[1, 'now'], [2, 'now'], [3, 'now'], [4, 'now'], [5, 'after its dependency'], [6, 'now']]);
    for (const [, w] of starts(s)) expect(String(w)).not.toMatch(/^(next|after \d)/);
  });

  test('raising slots from 1 to 4 with + shows three more rows as "now" before they start (AC-27)', () => {
    let s = stateWith(1, 1);
    expect(starts(s).filter(([, w]) => w === 'now')).toHaveLength(0);
    for (let i = 0; i < 3; i++) s = handleKey(s, { name: 'char', ch: '+' }, NOW).state;
    expect(s.runner.maxConcurrent).toBe(4);
    expect(starts(s).filter(([, w]) => w === 'now').map(([p]) => p)).toEqual([1, 2, 3]);
  });

  test('slots full: the next free slot is estimated from the running agents\' estimates, else said plainly', () => {
    let s = stateWith(1, 1);
    expect(starts(s)[0]).toEqual([1, 'when a slot frees']);
    // The running task was in the queue with a 25m estimate before it started 10 minutes ago.
    s = { ...s, estimates: { ...s.estimates, 'c0c0c0c0-00': 25 } };
    expect(starts(s)[0]).toEqual([1, 'in ~15m (next free slot)']);
  });

  test('the header line counts slots: total, running, free', () => {
    expect(slotsSummary(stateWith(6, 1), NOW)).toBe('6 slots · 1 running · 5 free');
    expect(slotsSummary(stateWith(1, 1), NOW)).toBe('1 slot · 1 running · 0 free');
  });
});

describe('a refused row says why, never "now" (AC-30)', () => {
  test('an overlap with a row in the list names it by position', () => {
    const s = refusedOverlap(stateWith(9, 1), 'a0a0a0a0-0004', 'a0a0a0a0-0001');
    expect(starts(s)[3]).toEqual([4, 'when #1 ends (same files)']);
    // The refused row takes no free slot: the rows behind it still start now.
    expect(starts(s)[5]).toEqual([6, 'now']);
  });

  test('an overlap with work not in the list names it by title (here: running work)', () => {
    const s = refusedOverlap(stateWith(9, 1), 'a0a0a0a0-0001', 'c0c0c0c0-00');
    expect(starts(s)[0]).toEqual([1, 'same files as "running work 1"']);
  });

  test('a server from before the holder field: the id in its sentence is read', () => {
    const s = refusedOverlap(stateWith(9, 1), 'a0a0a0a0-0004', 'a0a0a0a0-0001', false);
    expect(starts(s)[3]).toEqual([4, 'when #1 ends (same files)']);
  });

  test('an overlap with work top does not know still says it waits, not "now"', () => {
    const s = refusedOverlap(stateWith(9, 1), 'a0a0a0a0-0002', 'deadbeef-0bad');
    expect(starts(s)[1]).toEqual([2, 'when work on its files ends']);
  });

  test('other refusals in words: a cap, a dependency, an account limit', () => {
    let s = stateWith(9, 1);
    s = reduce(s, { type: 'claim_outcome', taskId: 'a0a0a0a0-0002', outcome: { at: NOW - 5_000, reason: 'all_candidates_deferred', exclusion: 'mission_concurrent', detail: 'Its mission is at its concurrency cap (3/3 tasks in flight).' } });
    s = reduce(s, { type: 'claim_outcome', taskId: 'a0a0a0a0-0003', outcome: { at: NOW - 5_000, reason: 'refused', status: 429, refusal: 'max_concurrent_workers' } });
    s = reduce(s, { type: 'claim_outcome', taskId: 'a0a0a0a0-0006', outcome: { at: NOW - 5_000, reason: 'no_pending_tasks', exclusion: 'deps_blocked', detail: 'It waits on a dependency.' } });
    expect(starts(s)).toEqual([[1, 'now'], [2, 'mission is at its task limit'], [3, 'account has no free slot'], [4, 'now'], [5, 'after its dependency'], [6, 'after its dependency']]);
  });

  test('a claim outcome that only says the task moved does not hold it', () => {
    const s = reduce(stateWith(9, 1), { type: 'claim_outcome', taskId: 'a0a0a0a0-0001', outcome: { at: NOW - 5_000, reason: 'no_pending_tasks', exclusion: 'state_changed', detail: 'Retry.' } });
    expect(starts(s)[0]).toEqual([1, 'now']);
  });

  test('runner paused: every row reads "paused", and the slot count says so', () => {
    const s = reduce(stateWith(9, 1), { type: 'runner_hold', hold: { since: iso(NOW - 10 * MIN), until: null } });
    expect(starts(s).every(([, w]) => w === 'paused')).toBe(true);
    expect(slotsSummary(s, NOW)).toBe('9 slots · 1 running · paused');
  });
});

describe('+ and - set the slots from top (R-43..R-45)', () => {
  const plus = { name: 'char' as const, ch: '+' };
  const minus = { name: 'char' as const, ch: '-' };

  test('+ asks the runner for one more slot and says what it does', () => {
    const r = handleKey(stateWith(6, 1), plus, NOW);
    expect(r.effects).toEqual([{ type: 'slots', slots: 7 }]);
    expect(r.state.status?.text).toBe('Slots now 7: 1 running, 6 free, looking for work for them now.');
  });

  test('- below the running count lets them finish and offers p to pause the newest instead', () => {
    let s = stateWith(4, 4);
    const r = handleKey(s, minus, NOW);
    expect(r.effects).toEqual([{ type: 'slots', slots: 3 }]);
    expect(r.state.status?.text).toBe('4 running, slots now 3: they finish, nothing new starts until 2 run. p pauses the newest instead.');
    const p = handleKey(r.state, { name: 'char', ch: 'p' }, NOW);
    expect(p.effects).toEqual([{ type: 'slots', slots: 3, extras: 'pause' }]);
    // Any other key drops the offer; p then pauses the selected row as usual.
    s = handleKey(handleKey(s, minus, NOW).state, { name: 'down' }, NOW).state;
    expect(s.slotOffer).toBeNull();
  });

  test('- stops at one slot: hold is the way to start nothing', () => {
    const r = handleKey(stateWith(1, 0), minus, NOW);
    expect(r.effects).toEqual([]);
    expect(r.state.status?.tone).toBe('error');
  });

  test('the runner\'s answer is the status line; a refused pause is said', () => {
    expect(actionResultText({ type: 'slots', slots: 2, extras: 'pause' }, { status: 200, body: { slots: 2, line: 'Slots now 2: paused the 2 newest agents; each continues in its own session when a slot frees.', failed: [] } }).text)
      .toContain('paused the 2 newest');
    expect(actionResultText({ type: 'slots', slots: 2, extras: 'pause' }, { status: 200, body: { slots: 2, line: 'x', failed: ['Could not pause "a": refused'] } }))
      .toEqual({ text: 'Could not pause "a": refused', tone: 'error' });
    expect(actionResultText({ type: 'slots', slots: 2 }, { status: 404, body: 'Not found' }).tone).toBe('error');
  });

  test('a slots frame from the runner moves the header', () => {
    const s = reduce(stateWith(3, 1), { type: 'slots', maxConcurrent: 5 });
    expect(s.runner.maxConcurrent).toBe(5);
  });
});

describe('what the claim loop did (task 9e12f377 part 3)', () => {
  const at = new Date(2026, 2, 10, 14, 2, 0).getTime();
  test('started, nothing to start with the reason in words, and looking now', () => {
    let s = stateWith(9, 1);
    expect(claimLoopLine(s, NOW)).toBeNull();
    s = reduce(s, { type: 'claim_outcome', outcome: { at, reason: 'claimed', started: 2 } });
    expect(claimLoopLine(s, NOW)).toBe('Looked for work 14:02 · started 2');
    s = reduce(s, { type: 'claim_outcome', outcome: { at, reason: 'all_candidates_deferred', deferrals: { soft_overlap: 3 } } });
    expect(claimLoopLine(s, NOW)).toBe('Looked for work 14:02 · nothing to start: every waiting task: waits for work on the same files');
    s = reduce(s, { type: 'claim_outcome', outcome: { at, reason: 'no_pending_tasks' } });
    expect(claimLoopLine(s, NOW)).toBe('Looked for work 14:02 · nothing to start: nothing is waiting for this runner');
    s = reduce(s, { type: 'claim_loop', looking: true });
    expect(claimLoopLine(s, NOW)).toBe('Looking for work…');
    // The claim coming back ends "looking".
    s = reduce(s, { type: 'claim_outcome', outcome: { at: NOW, reason: 'claimed', started: 1 } });
    expect(claimLoopLine(s, NOW)).toBe('Looked for work 15:00 · started 1');
  });

  test('a refused claim and an account limit, in words', () => {
    let s = reduce(stateWith(9, 1), { type: 'claim_outcome', outcome: { at, reason: 'refused', status: 429, refusal: 'max_concurrent_workers' } });
    expect(claimLoopLine(s, NOW)).toBe("Looked for work 14:02 · nothing to start: every slot the account may use is in use");
    s = reduce(s, { type: 'claim_outcome', outcome: { at, reason: 'no_slots' } });
    expect(claimLoopLine(s, NOW)).toContain("every slot the account may use is in use");
  });

  test('not while held, nor with every slot busy (the header says so)', () => {
    let s = reduce(stateWith(1, 1), { type: 'claim_outcome', outcome: { at, reason: 'no_pending_tasks' } });
    expect(claimLoopLine(s, NOW)).toBeNull();
    s = reduce(stateWith(9, 1), { type: 'runner_hold', hold: { since: iso(NOW - MIN), until: null } });
    s = reduce(s, { type: 'claim_outcome', outcome: { at, reason: 'no_pending_tasks' } });
    expect(claimLoopLine(s, NOW)).toBeNull();
  });

  test('an init frame says a claim is out', () => {
    const s = reduce(stateWith(9, 1), { type: 'init', lookingForWork: true });
    expect(claimLoopLine(s, NOW)).toBe('Looking for work…');
  });
});

describe('frames (R-7)', () => {
  /** The owner's case, fixed: 9 slots, 1 running, one row refused on overlap with the row above it. */
  const owner = () => {
    let s = refusedOverlap(stateWith(9, 1), 'a0a0a0a0-0004', 'a0a0a0a0-0001');
    s = reduce(s, { type: 'claim_outcome', outcome: { at: new Date(2026, 2, 10, 14, 58, 0).getTime(), reason: 'claimed', started: 3 } });
    return s;
  };

  for (const [cols, rows] of [[80, 24], [120, 40]] as const) {
    test(`${cols}x${rows}: slots on the tab line, "now" rows, the refused row's reason, the claim-loop line`, () => {
      const lines = renderFrame(owner(), { cols, rows, now: NOW, palette: plain });
      expect(lines).toHaveLength(rows);
      for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(cols);
      const t = text(lines);
      expect(t).toMatch(/9 slots · (1 running · )?8 free/);
      expect(t).toContain('1 of 9 busy');
      expect(t).toContain('Looked for work 14:58 · started 3');
      expect(t).toContain('when #1 ends (same files)');
      expect(t).not.toMatch(/\bnext\s*$/m);
      expect(t).not.toMatch(/after \d/);
      if (cols >= 120) expect(t).toContain('- fewer  + more');
      expect(t).toMatchSnapshot();
    });
  }
});

describe('top --frame (one frame, read-only)', () => {
  test('reads the socket with GETs and the first init frame only, and draws the Queue', async () => {
    const posts: string[] = [];
    const gets: string[] = [];
    const s = stateWith(9, 1);
    const client: SocketClient = {
      async get(path: string) {
        gets.push(path);
        if (path === '/api/runner') return { status: 200, body: { pid: 1, version: '0.358.1' } };
        if (path === '/api/config') return { status: 200, body: { maxConcurrent: 9, builddServer: 'https://buildd.dev' } };
        if (path.startsWith('/api/workers')) return { status: 200, body: { workers: Object.values(s.workers) } };
        if (path === '/api/workspaces') return { status: 200, body: { workspaces: s.workspaces } };
        if (path === '/api/tasks') return { status: 200, body: { tasks: s.tasks } };
        if (path === '/api/queue') return { status: 200, body: QUEUE };
        return { status: 404, body: 'Not found' };
      },
      async post(path: string) { posts.push(path); return { status: 500, body: {} }; },
      async events(onEvent, signal) {
        onEvent({ type: 'init', workers: [], hold: null, lookingForWork: false, claimOutcomes: { tasks: { 'a0a0a0a0-0004': { at: NOW - 20_000, reason: 'all_candidates_deferred', exclusion: 'soft_overlap', detail: SOFT('a0a0a0a0-0001') } }, broad: null } });
        await new Promise<void>(r => (signal.aborted ? r() : signal.addEventListener('abort', () => r())));
      },
    };
    const lines = await frameOnce({ socketPath: '/nonexistent', client, view: 'queue', cols: 120, rows: 40, hostname: 'atlas', now: NOW });
    expect(posts).toEqual([]);
    expect(gets).toContain('/api/queue');
    const t = text(lines);
    expect(t).toContain('[ Queue ]');
    expect(t).toContain('when #1 ends (same files)');
    expect(t).toContain('● online');
  });
});
