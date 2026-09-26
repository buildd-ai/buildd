import { describe, expect, it } from 'bun:test';
import { groupTasksByPhase } from './flight-strip-nav';
import { resolveReviewerGate } from './reviewer-gate';
import {
  buildPulseSegments,
  deriveFeedTaskState,
  deriveFeedPrState,
  foldMissionDeliverables,
  orderDeliverables,
  PULSE_FOLD_THRESHOLD,
  PULSE_STATE_TOKEN,
  PULSE_STATE_GLYPH,
  PR_STATE_TOKEN,
  buildPulseCaption,
  missionDeliverableCounts,
  pulseDoneCounts,
  type FeedPrState,
  type MissionFeedTaskInput,
} from './mission-pulse';

// Illustrative fixtures only — no real mission or task data.
let clock = Date.UTC(2026, 0, 1);
function t(id: string, over: Partial<MissionFeedTaskInput> = {}): MissionFeedTaskInput {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), ...over };
}
const phase = (index: number, label: string) => ({ missionPhaseIndex: index, missionPhaseLabel: label });

describe('foldMissionDeliverables (D1)', () => {
  it('folds attempts under their parent, never as rows', () => {
    const parent = t('p', { status: 'completed' });
    const retry = t('r', { taskClass: 'attempt', parentTaskId: 'p', status: 'completed' });
    const review = t('rv', { taskClass: 'attempt', parentTaskId: 'p', status: 'completed' });
    const { rows } = foldMissionDeliverables([review, retry, parent]);
    expect(rows.map(r => r.task.id)).toEqual(['p']);
    expect(rows[0].attempts.map(a => a.id)).toEqual(['r', 'rv']);
  });

  it('folds cancelled and failed re-creations under the newest same-title task', () => {
    const first = t('a1', { title: 'Add lease column', status: 'cancelled' });
    const second = t('a2', { title: 'Add lease column', status: 'failed' });
    const third = t('a3', { title: 'Add lease column', status: 'in_progress' });
    const other = t('b', { title: 'Heartbeat renew' });
    const { rows } = foldMissionDeliverables([first, second, third, other]);
    expect(rows.map(r => r.task.id)).toEqual(['a3', 'b']);
    expect(rows[0].attempts.map(a => a.id)).toEqual(['a1', 'a2']);
  });

  it('keeps two completed tasks that happen to share a title as two rows', () => {
    const { rows } = foldMissionDeliverables([
      t('x1', { title: 'Update docs', status: 'completed' }),
      t('x2', { title: 'Update docs', status: 'completed' }),
    ]);
    expect(rows.map(r => r.task.id)).toEqual(['x1', 'x2']);
  });

  it('re-points an attempt whose parent was folded into its re-creation', () => {
    const old = t('o', { title: 'Schema v2', status: 'cancelled' });
    const oldRetry = t('or', { taskClass: 'attempt', parentTaskId: 'o', status: 'failed' });
    const current = t('c', { title: 'Schema v2', status: 'completed' });
    const { rows } = foldMissionDeliverables([old, oldRetry, current]);
    expect(rows.map(r => r.task.id)).toEqual(['c']);
    expect(rows[0].attempts.map(a => a.id).sort()).toEqual(['o', 'or']);
  });

  it('sends bookkeeping rows and orphan attempts to bookkeeping, not rows', () => {
    const plan = t('plan', { taskClass: 'bookkeeping', mode: 'planning' });
    const orphan = t('orph', { taskClass: 'attempt', parentTaskId: 'not-in-mission' });
    const work = t('w');
    const folded = foldMissionDeliverables([plan, orphan, work]);
    expect(folded.rows.map(r => r.task.id)).toEqual(['w']);
    expect(folded.bookkeeping.map(b => b.id).sort()).toEqual(['orph', 'plan']);
  });
});

describe('deriveFeedPrState', () => {
  it('reads the real PR state, not a constant success colour', () => {
    expect(deriveFeedPrState(null)).toBeNull();
    expect(deriveFeedPrState({ status: 'completed', prNumber: 412 })).toEqual({ number: 412, state: 'open' });
    expect(deriveFeedPrState({ status: 'completed', prNumber: 412, mergedAt: new Date() })?.state).toBe('merged');
    expect(deriveFeedPrState({ status: 'completed', prNumber: 412, prLifecycleStatus: 'ci_failed' })?.state).toBe('ci_failed');
    expect(deriveFeedPrState({ status: 'completed', prNumber: 412, prLifecycleStatus: 'closed' })?.state).toBe('closed');
  });

  // Every value of workers.prLifecycleStatus (packages/core/db/schema.ts), plus null.
  const LIFECYCLE: Array<[string | null, FeedPrState, 'info' | 'success' | 'error']> = [
    [null, 'open', 'info'],
    ['pr_open', 'checks_running', 'info'],
    ['ci_running', 'checks_running', 'info'],
    ['ci_green', 'open', 'info'],
    ['ci_failed', 'ci_failed', 'error'],
    ['merged', 'merged', 'success'],
    ['conflict', 'conflict', 'error'],
    ['closed', 'closed', 'error'],
    ['unresolvable', 'unresolvable', 'error'],
  ];
  for (const [lifecycle, state, token] of LIFECYCLE) {
    it(`prLifecycleStatus=${lifecycle} → ${state} (${token})`, () => {
      const pr = deriveFeedPrState({ status: 'completed', prNumber: 9, prLifecycleStatus: lifecycle });
      expect(pr?.state).toBe(state);
      expect(PR_STATE_TOKEN[pr!.state]).toBe(token);
    });
  }
});

describe('deriveFeedTaskState × PR lifecycle (completed task)', () => {
  // [lifecycle, no open attempt, with an open fix attempt]
  const TABLE: Array<[string | null, { state: string; needsYou: string | null }, { state: string; needsYou: string | null }]> = [
    // Unknown lifecycle with a PR: the only safe reading is "open, yours to merge".
    [null, { state: 'needs_you', needsYou: 'pr' }, { state: 'queued', needsYou: null }],
    // CI has not reported / is running: the platform is handling it, auto-merge evaluates on green.
    ['pr_open', { state: 'moving', needsYou: null }, { state: 'moving', needsYou: null }],
    ['ci_running', { state: 'moving', needsYou: null }, { state: 'moving', needsYou: null }],
    // Auto-merge runs on the green transition, so a PR still open at green was declined or auto-merge is off.
    ['ci_green', { state: 'needs_you', needsYou: 'pr' }, { state: 'queued', needsYou: null }],
    ['ci_failed', { state: 'needs_you', needsYou: 'pr' }, { state: 'failed', needsYou: null }],
    ['conflict', { state: 'needs_you', needsYou: 'pr' }, { state: 'failed', needsYou: null }],
    ['merged', { state: 'done', needsYou: null }, { state: 'done', needsYou: null }],
    ['closed', { state: 'done', needsYou: null }, { state: 'done', needsYou: null }],
    // Terminal: buildd cannot resolve the PR, so nobody can act on it from here.
    ['unresolvable', { state: 'failed', needsYou: null }, { state: 'failed', needsYou: null }],
  ];
  for (const [lifecycle, bare, withAttempt] of TABLE) {
    it(`prLifecycleStatus=${lifecycle}`, () => {
      const task = t(`pr-${lifecycle}`, { status: 'completed', worker: { status: 'completed', prNumber: 9, prLifecycleStatus: lifecycle } });
      expect(deriveFeedTaskState({ task, attempts: [] })).toMatchObject(bare);
      const fix = t(`fix-${lifecycle}`, { taskClass: 'attempt', parentTaskId: task.id, status: 'pending' });
      expect(deriveFeedTaskState({ task, attempts: [fix] })).toMatchObject(withAttempt);
    });
  }
});

describe('deriveFeedTaskState — a just-green PR is still merging (shared with the reviewer gate)', () => {
  const NOW = Date.parse('2026-01-01T12:00:00Z');
  const green = (agoMs: number) => t(`green-${agoMs}`, {
    status: 'completed',
    worker: { status: 'completed', prNumber: 9, prLifecycleStatus: 'ci_green', updatedAt: new Date(NOW - agoMs) },
  });
  it('inside the auto-merge grace window the platform owns the merge: moving, not needs-you', () => {
    expect(deriveFeedTaskState({ task: green(20_000), attempts: [] }, { now: NOW })).toMatchObject({ state: 'moving', needsYou: null });
  });
  it('past the grace window the merge rail held it: needs you', () => {
    expect(deriveFeedTaskState({ task: green(10 * 60_000), attempts: [] }, { now: NOW })).toMatchObject({ state: 'needs_you', needsYou: 'pr' });
  });
  it('agrees with resolveReviewerGate on both sides of the boundary', () => {
    for (const ago of [0, 20_000, 4 * 60_000, 6 * 60_000, 60 * 60_000]) {
      const gate = resolveReviewerGate({
        policyTier: 'auto-threshold', escalationReason: null, approvalSummary: null, reviewerTask: null,
        now: new Date(NOW), prLifecycleStatus: 'ci_green', prLifecycleUpdatedAt: new Date(NOW - ago),
      } as any);
      const feed = deriveFeedTaskState({ task: green(ago), attempts: [] }, { now: NOW });
      expect(feed.state === 'needs_you').toBe(gate.actor === 'human');
    }
  });
});

describe('deriveFeedTaskState', () => {
  const row = (task: MissionFeedTaskInput, attempts: MissionFeedTaskInput[] = []) => ({ task, attempts });

  it('waiting_input needs you', () => {
    expect(deriveFeedTaskState(row(t('a', { status: 'in_progress', worker: { status: 'waiting_input' } })))).toMatchObject({ state: 'needs_you', needsYou: 'input' });
  });
  it('an open mission question or decision naming the task needs you', () => {
    const q = t('q', { status: 'completed' });
    expect(deriveFeedTaskState(row(q), { openQuestions: new Map([['q', new Date()]]) }).needsYou).toBe('question');
    expect(deriveFeedTaskState(row(q), { openDecisions: new Map([['q', new Date()]]) }).needsYou).toBe('decision');
  });
  it('a completed task with an open PR awaits your merge; merged is done', () => {
    expect(deriveFeedTaskState(row(t('a', { status: 'completed', worker: { status: 'completed', prNumber: 7 } }))).needsYou).toBe('pr');
    expect(deriveFeedTaskState(row(t('b', { status: 'completed', worker: { status: 'completed', prNumber: 7, mergedAt: new Date() } }))).state).toBe('done');
  });
  it('failed with no automatic retry pending needs you; with one queued it reads failed; with one live it moves', () => {
    const failed = t('f', { status: 'failed' });
    expect(deriveFeedTaskState(row(failed)).needsYou).toBe('failed');
    expect(deriveFeedTaskState(row(failed, [t('r', { taskClass: 'attempt', status: 'pending' })])).state).toBe('failed');
    expect(deriveFeedTaskState(row(failed, [t('r2', { taskClass: 'attempt', status: 'in_progress', worker: { status: 'running' } })])).state).toBe('moving');
  });
  it('claimed / starting / running move; pending queues; cancelled is skipped', () => {
    expect(deriveFeedTaskState(row(t('a', { status: 'assigned' }))).state).toBe('moving');
    expect(deriveFeedTaskState(row(t('b', { status: 'pending', worker: { status: 'starting' } }))).state).toBe('moving');
    expect(deriveFeedTaskState(row(t('c'))).state).toBe('queued');
    expect(deriveFeedTaskState(row(t('d', { status: 'cancelled' }))).state).toBe('skipped');
  });
});

describe('orderDeliverables', () => {
  it('is phase order, then createdAt — independent of input order', () => {
    const a = t('a', phase(1, 'BUILD'));
    const b = t('b', phase(0, 'THINK'));
    const c = t('c', phase(1, 'BUILD'));
    const d = t('d', phase(0, 'THINK'));
    const { rows } = foldMissionDeliverables([c, a, d, b]);
    expect(orderDeliverables(rows).map(r => r.task.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('buildPulseSegments', () => {
  it('AC-4: segment order equals the flattened groupTasksByPhase order, and never moves with state', () => {
    const tasks = [
      t('a', { ...phase(1, 'BUILD'), status: 'completed' }),
      t('b', { ...phase(0, 'THINK'), status: 'completed' }),
      t('c', { ...phase(1, 'BUILD'), status: 'in_progress' }),
      t('d', { ...phase(2, 'CHECK') }),
      t('e', { ...phase(0, 'THINK'), status: 'failed' }),
    ];
    const expected = groupTasksByPhase([...tasks].sort((x, y) => +new Date(x.createdAt) - +new Date(y.createdAt))).flatMap(g => g.tasks.map(x => x.id));
    const segs = buildPulseSegments(tasks);
    expect(segs.map(s => s.taskId)).toEqual(expected);
    // Flip a state: order is unchanged.
    const moved = buildPulseSegments(tasks.map(x => (x.id === 'd' ? { ...x, status: 'completed' } : x)));
    expect(moved.map(s => s.taskId)).toEqual(expected);
  });

  it('marks a 2px gap before the first segment of every phase but the first', () => {
    const segs = buildPulseSegments([
      t('a', phase(0, 'THINK')), t('b', phase(0, 'THINK')), t('c', phase(1, 'BUILD')), t('d', phase(2, 'CHECK')),
    ]);
    expect(segs.map(s => s.gapBefore)).toEqual([false, false, true, true]);
  });

  it('maps states to tokens', () => {
    const segs = buildPulseSegments([
      t('n', { status: 'in_progress', worker: { status: 'waiting_input' } }),
      t('m', { status: 'in_progress', worker: { status: 'running' } }),
      t('q'),
      t('d', { status: 'completed' }),
      t('f', { status: 'failed' }),
    ]);
    expect(segs.map(s => s.state)).toEqual(['needs_you', 'moving', 'queued', 'done', 'needs_you']);
    expect(PULSE_STATE_TOKEN).toMatchObject({ needs_you: 'warning', moving: 'accent', queued: 'border', done: 'success', failed: 'error' });
  });

  it('counts only deliverable rows: attempts and cancelled re-creations add no segments (D1)', () => {
    const segs = buildPulseSegments([
      t('a', { title: 'Same', status: 'cancelled' }),
      t('b', { title: 'Same', status: 'completed' }),
      t('r', { taskClass: 'attempt', parentTaskId: 'b' }),
      t('plan', { taskClass: 'bookkeeping' }),
    ]);
    expect(segs.map(s => s.taskId)).toEqual(['b']);
  });

  it(`draws one segment per task at ${PULSE_FOLD_THRESHOLD}, one per phase at ${PULSE_FOLD_THRESHOLD + 1}`, () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) =>
      t(`t${n}-${i}`, { ...phase(i % 3, ['THINK', 'BUILD', 'CHECK'][i % 3]), status: i % 3 === 0 ? 'completed' : 'pending' }));
    const at = buildPulseSegments(make(PULSE_FOLD_THRESHOLD));
    expect(at).toHaveLength(PULSE_FOLD_THRESHOLD);
    expect(at.every(s => s.kind === 'task')).toBe(true);

    const over = buildPulseSegments(make(PULSE_FOLD_THRESHOLD + 1));
    expect(over).toHaveLength(3);
    expect(over.every(s => s.kind === 'phase')).toBe(true);
    // Scrub targets the phase's first task; fill is the phase's done fraction.
    expect(over[0]).toMatchObject({ kind: 'phase', phaseLabel: 'THINK', fill: 1, state: 'done' });
    expect(over[1]).toMatchObject({ phaseLabel: 'BUILD', fill: 0, state: 'queued' });
    expect(over.map(s => s.gapBefore)).toEqual([false, true, true]);
  });
});

// ─── F3: one count definition ────────────────────────────────────────────────

describe('F3: n/N excludes cancelled rows', () => {
  it('pulseDoneCounts: cancelled is neither done nor in N', () => {
    const segs = buildPulseSegments([
      t('a', { status: 'completed' }), t('b', { status: 'cancelled' }), t('c'), t('d', { status: 'failed' }),
    ]);
    expect(segs.map(s => s.state)).toEqual(['done', 'skipped', 'queued', 'needs_you']);
    expect(pulseDoneCounts(segs)).toEqual({ done: 1, total: 3 });
    expect(buildPulseCaption(segs)).toBe('1/3');
  });

  it('a folded phase counts the same way', () => {
    const many = Array.from({ length: PULSE_FOLD_THRESHOLD + 2 }, (_, i) =>
      t(`x${i}`, { ...phase(0, 'BUILD'), status: i === 0 ? 'cancelled' : i < 11 ? 'completed' : 'pending' }));
    const segs = buildPulseSegments(many);
    expect(segs).toHaveLength(1);
    expect(pulseDoneCounts(segs)).toEqual({ done: 10, total: PULSE_FOLD_THRESHOLD + 1 });
  });

  it('the caption is empty with no countable rows (F7a: never "0/0")', () => {
    expect(buildPulseCaption([])).toBe('');
    expect(buildPulseCaption(buildPulseSegments([t('a', { status: 'cancelled' })]))).toBe('');
    expect(buildPulseCaption([], { liveWorkers: 2 })).toBe('2 live');
  });

  it('missionDeliverableCounts is the same definition, from tasks', () => {
    const tasks = [t('a', { status: 'completed' }), t('b', { status: 'cancelled' }), t('c')];
    expect(missionDeliverableCounts(tasks)).toEqual({ done: 1, total: 2, cancelled: 1 });
  });

  it('cancelled has its own glyph, never the queued one', () => {
    expect(PULSE_STATE_GLYPH.skipped).not.toBe(PULSE_STATE_GLYPH.queued);
  });
});
