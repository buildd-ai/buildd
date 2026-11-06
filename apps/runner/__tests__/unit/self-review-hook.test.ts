/**
 * Self-review guard, recording stage (Living Spec f3742450, T2). Never denies.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/self-review-hook.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { createSelfReviewGuardHook, resolveSelfReviewMode } from '../../src/self-review-guard';
import { createVerifyGuardHook } from '../../src/verify-guard';
import type { Milestone } from '../../src/types';

const signal = { signal: new AbortController().signal };
const complete = (params: Record<string, unknown> = {}) =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'mcp__buildd__buildd_tasks', tool_input: { action: 'complete_task', params } }) as any;
const denied = (r: any) => r?.hookSpecificOutput?.permissionDecision === 'deny';

function setup(over: Record<string, any> = {}) {
  const milestones: Milestone[] = [];
  const hook = createSelfReviewGuardHook({
    worker: { id: 'w1', toolCalls: [{}, {}], tokenTally: { inputTokens: 10, outputTokens: 5 } } as any,
    task: { title: 'T', description: '- add the thing\n- run the tests', roleSlug: 'builder', pathManifest: ['a.ts'] } as any,
    mode: 'recording',
    addMilestone: (m: Milestone) => milestones.push(m),
    openFailures: () => [],
    log: () => {},
    ...over,
  });
  return { hook, milestones };
}
const labels = (ms: Milestone[]) => ms.map((m: any) => m.label as string);

describe('resolveSelfReviewMode', () => {
  test('defaults to off; only known modes accepted', () => {
    expect(resolveSelfReviewMode(undefined)).toBe('off');
    expect(resolveSelfReviewMode({})).toBe('off');
    expect(resolveSelfReviewMode({ selfReview: 'bogus' })).toBe('off');
    expect(resolveSelfReviewMode({ selfReview: 'recording' })).toBe('recording');
  });
});

describe('recording mode', () => {
  test('arm draw is deterministic and covers both arms across workers', async () => {
    const { drawSelfReviewArm } = await import('../../src/self-review-guard');
    expect(drawSelfReviewArm('w1')).toBe(drawSelfReviewArm('w1'));
    const arms = new Set(Array.from({ length: 40 }, (_, n) => drawSelfReviewArm(`worker-${n}`)));
    expect(arms.size).toBe(2);
  });

  test('never denies and logs mode, a drawn arm, version and item ids (AC-4)', async () => {
    const { hook, milestones } = setup();
    expect(denied(await hook(complete(), undefined, signal))).toBe(false);
    const line = labels(milestones).join('\n');
    expect(line).toContain('mode=recording');
    expect(line).toMatch(/arm=(control|treatment) propensity=0.5/);
    expect(line).not.toContain('arm=none');
    expect(line).toContain('version=1');
    expect(line).toContain('req-1');
    expect(line).toContain('scope');
    expect(line).toContain('tokens=15');
    expect(line).toMatch(/checklist=\[req-1\] \S/); // the checklist text, not only ids
  });

  test('writes a structured answer record with checklist, answers and change flag', async () => {
    const { hook, milestones } = setup();
    await hook(complete({ structuredOutput: { selfReview: [{ id: 'req-1', answer: 'met', evidence: 'x' }] } }), undefined, signal);
    const rec = labels(milestones).find(l => l.startsWith('Self-review record: '))!;
    const j = JSON.parse(rec.slice('Self-review record: '.length));
    expect(j).toMatchObject({ outcome: 'eligible', checklistVersion: 1, addedTurns: 0, addedTokens: 0, workChangedAfterDenial: false });
    expect(j.itemIds).toContain('req-1');
    expect(j.answers[0].answer).toBe('met');
  });

  test('record label stays valid JSON when answers carry long evidence', async () => {
    const { hook, milestones } = setup();
    const answers = Array.from({ length: 30 }, (_, i) => ({ id: `req-${i}`, answer: 'met', evidence: 'e'.repeat(5000) }));
    await hook(complete({ structuredOutput: { selfReview: answers } }), undefined, signal);
    const rec = labels(milestones).find(l => l.startsWith('Self-review record: '))!;
    expect(rec.length).toBeLessThanOrEqual(1000);
    const j = JSON.parse(rec.slice('Self-review record: '.length));
    expect(j.outcome).toBe('eligible');
  });

  test('fires at most once per worker', async () => {
    const { hook, milestones } = setup();
    await hook(complete(), undefined, signal);
    await hook(complete(), undefined, signal);
    expect(milestones).toHaveLength(2);
  });

  test('exempt tasks record the exemption reason', async () => {
    const { hook, milestones } = setup({ task: { roleSlug: 'reviewer', description: '- x' } });
    expect(denied(await hook(complete(), undefined, signal))).toBe(false);
    expect(labels(milestones).join()).toContain('exempt=reviewer-role');
  });

  test('bookkeeping tasks (task.taskClass) are exempt', async () => {
    const { hook, milestones } = setup({ task: { roleSlug: 'builder', description: '- x', taskClass: 'bookkeeping', mode: 'execution' } });
    expect(denied(await hook(complete(), undefined, signal))).toBe(false);
    expect(labels(milestones).join()).toContain('exempt=bookkeeping');
  });

  test('planning tasks (task.mode) are exempt', async () => {
    const { hook, milestones } = setup({ task: { roleSlug: 'builder', description: '- x', taskClass: 'standard', mode: 'planning' } });
    await hook(complete(), undefined, signal);
    expect(labels(milestones).join()).toContain('exempt=planning');
  });

  test('legacy context flags no longer exempt', async () => {
    const { hook, milestones } = setup({ task: { roleSlug: 'builder', description: '- x', context: { bookkeeping: true, planning: true } } });
    await hook(complete(), undefined, signal);
    expect(labels(milestones).join()).not.toContain('exempt=');
  });

  test('failure reports are exempt (error)', async () => {
    const { hook, milestones } = setup();
    await hook(complete({ error: 'boom' }), undefined, signal);
    expect(labels(milestones).join()).toContain('exempt=error');
  });

  test('builder failure fails open', async () => {
    const { hook } = setup({ task: { get description() { throw new Error('x'); } } });
    expect(denied(await hook(complete(), undefined, signal))).toBe(false);
  });

  test('ignores other tools and non-completion actions', async () => {
    const { hook, milestones } = setup();
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, undefined, signal);
    await hook(complete(), undefined, signal); // fires
    expect(milestones).toHaveLength(2);
  });
});

describe('mode off', () => {
  test('creates no state and no log', async () => {
    const { hook, milestones } = setup({ mode: 'off' });
    expect(await hook(complete(), undefined, signal)).toEqual({});
    expect(await hook(complete(), undefined, signal)).toEqual({});
    expect(milestones).toHaveLength(0);
  });
});

describe('composed with verify-guard in registration order (AC-1)', () => {
  test('an open verify failure is refused first and the stage does not fire', async () => {
    const open = [{ family: 'test', command: 'bun run test', exitCode: 1, timedOut: false }] as any;
    const milestones: Milestone[] = [];
    const worker = { id: 'w1', toolCalls: [] } as any;
    const verify = createVerifyGuardHook({ worker, isReviewer: false, openFailures: () => open, log: () => {} });
    const review = createSelfReviewGuardHook({
      worker, task: { description: '- a' } as any, mode: 'recording',
      addMilestone: (m: Milestone) => milestones.push(m), openFailures: () => open, log: () => {},
    });
    let result: any = {};
    for (const h of [verify, review]) {
      result = await h(complete(), undefined, signal);
      if (denied(result)) break;
    }
    expect(denied(result)).toBe(true);
    expect(milestones).toHaveLength(0);
    // The guard also stands down on its own if run alongside (parallel hooks).
    expect(await review(complete(), undefined, signal)).toEqual({});
    expect(milestones).toHaveLength(0);
  });
});
