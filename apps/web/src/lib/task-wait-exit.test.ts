import { describe, it, expect } from 'bun:test';
import { decideWaitExit, parseWaitOn, waitExitEnabled, wouldCycle } from './task-wait-exit';

const T = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';
const W = 'ws-1';

const task = (over: Partial<Parameters<typeof decideWaitExit>[0]['task']> = {}) => ({
  id: T, workspaceId: W, status: 'in_progress', dependsOn: null as string[] | null, deliveryId: null, ...over,
});
const blocker = (over: Record<string, unknown> = {}) => ({ id: B, workspaceId: W, status: 'in_progress', loopState: null, title: 'Runner image credentials', ...over });
const decide = (over: Partial<Parameters<typeof decideWaitExit>[0]> = {}) => decideWaitExit({
  enabled: true, task: task(), blockerTaskId: B, blocker: blocker(), blockerHasOpenPr: false, edges: new Map(), ...over,
});

describe('waitExitEnabled', () => {
  it('is on only when the workspace sets waitOnTask: true', () => {
    expect(waitExitEnabled({ waitOnTask: true })).toBe(true);
    expect(waitExitEnabled({ waitOnTask: 'yes' })).toBe(false);
    expect(waitExitEnabled({})).toBe(false);
    expect(waitExitEnabled(null)).toBe(false);
  });
});

describe('parseWaitOn', () => {
  it('needs a full task id and a reason', () => {
    expect(parseWaitOn({ taskId: B, reason: '  needs the R-1 repair  ' })).toEqual({ ok: true, blockerTaskId: B, reason: 'needs the R-1 repair' });
    expect(parseWaitOn({ taskId: '22222222', reason: 'x' }).ok).toBe(false);
    expect(parseWaitOn({ taskId: B, reason: ' ' }).ok).toBe(false);
    expect(parseWaitOn(null).ok).toBe(false);
  });
});

describe('wouldCycle', () => {
  it('finds the task reachable from the blocker', () => {
    expect(wouldCycle(T, B, new Map([[B, [C]], [C, [T]]]))).toBe(true);
    expect(wouldCycle(T, B, new Map([[B, [C]], [C, []]]))).toBe(false);
    expect(wouldCycle(T, T, new Map())).toBe(true);
  });
  it('terminates on a cycle that does not include the task', () => {
    expect(wouldCycle(T, B, new Map([[B, [C]], [C, [B]]]))).toBe(false);
  });
});

describe('decideWaitExit', () => {
  it('adds the blocker to dependsOn and keeps existing edges', () => {
    expect(decide({ task: task({ dependsOn: [C] }) })).toEqual({ ok: true, dependsOn: [C, B] });
    expect(decide({ task: task({ dependsOn: [B] }) })).toEqual({ ok: true, dependsOn: [B] });
  });

  it('accepts a completed blocker whose PR has not merged yet', () => {
    expect(decide({ blocker: blocker({ status: 'completed' }), blockerHasOpenPr: true }).ok).toBe(true);
  });

  it('accepts a failed blocker: someone may still retry it, and the safety net surfaces it', () => {
    expect(decide({ blocker: blocker({ status: 'failed' }) }).ok).toBe(true);
  });

  const code = (d: ReturnType<typeof decideWaitExit>) => (d.ok ? null : d.code);

  it('is off unless the workspace flag is on', () => {
    expect(code(decide({ enabled: false }))).toBe('wait_exit_disabled');
  });
  it('refuses self, unknown and other-workspace blockers', () => {
    expect(code(decide({ blockerTaskId: T, blocker: blocker({ id: T }) }))).toBe('self');
    expect(code(decide({ blocker: null }))).toBe('unknown_blocker');
    expect(code(decide({ blocker: blocker({ workspaceId: 'ws-2' }) }))).toBe('unknown_blocker');
  });
  it('refuses a blocker that already merged or was cancelled', () => {
    expect(code(decide({ blocker: blocker({ status: 'completed' }) }))).toBe('blocker_merged');
    expect(code(decide({ blocker: blocker({ status: 'cancelled' }) }))).toBe('blocker_cancelled');
  });
  it('treats a completed loop task that is not satisfied as not merged', () => {
    expect(decide({ blocker: blocker({ status: 'completed', loopState: 'condition_unmet' }) }).ok).toBe(true);
  });
  it('refuses a cycle through other tasks', () => {
    expect(code(decide({ edges: new Map([[B, [C]], [C, [T]]]) }))).toBe('cycle');
  });
  it('refuses a terminal task and a delivery-owned task', () => {
    expect(code(decide({ task: task({ status: 'completed' }) }))).toBe('not_open');
    expect(code(decide({ task: task({ deliveryId: 'd-1' }) }))).toBe('delivery_owned');
  });
});

describe('decideWaitExit: a task started anyway (spec 36df686b R-8, R-11)', () => {
  const code = (d: ReturnType<typeof decideWaitExit>) => (d.ok ? null : d.code);

  it('may park on its prerequisite without the workspace flag: it is the only park for an assessment', () => {
    expect(code(decide({ enabled: false }))).toBe('wait_exit_disabled');
    const d = decide({ enabled: false, startAnyway: { parks: 0 } });
    expect(d).toEqual({ ok: true, dependsOn: [B] });
  });

  it('keeps the declared edge: parking adds nothing it already has', () => {
    expect(decide({ enabled: false, startAnyway: { parks: 0 }, task: task({ dependsOn: [B, C] }) })).toEqual({ ok: true, dependsOn: [B, C] });
  });

  it('refuses to park again once the budget is spent, so a dead prerequisite cannot loop', () => {
    expect(code(decide({ startAnyway: { parks: 3 } }))).toBe('park_limit');
    expect(decide({ startAnyway: { parks: 2 } }).ok).toBe(true);
  });

  it('still refuses a merged prerequisite: the recheck that stops a race from stranding the task', () => {
    expect(code(decide({ startAnyway: { parks: 0 }, blocker: blocker({ status: 'completed' }) }))).toBe('blocker_merged');
  });

  it('still refuses a cancelled prerequisite and a cycle', () => {
    expect(code(decide({ startAnyway: { parks: 0 }, blocker: blocker({ status: 'cancelled' }) }))).toBe('blocker_cancelled');
    expect(code(decide({ startAnyway: { parks: 0 }, edges: new Map([[B, [T]]]) }))).toBe('cycle');
  });
});
