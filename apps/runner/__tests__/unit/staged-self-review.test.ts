/**
 * Acceptance tests for spec "Staged self-review before complete_task
 * (intent-only, measured)" revision 1: the runner half (hook, checklist,
 * exemptions, recording, fail-open). Written before the build: every test
 * fails until `apps/runner/src/staged-self-review.ts` exists.
 *
 * Contract the build must meet (module `apps/runner/src/staged-self-review.ts`):
 *  - `createStagedSelfReviewHook(deps)`: PreToolUse hook, same shape as
 *    `createVerifyGuardHook`. deps: { worker:{id}, task: StagedTask, mode:
 *    'off'|'recording'|'acting', arm: 'control'|'treatment', propensity?,
 *    openFailures?, buildChecklist?, record(entry), log? }.
 *  - `buildIntentChecklist(task)` -> { version: string, items: {id,text}[] }.
 *  - Every `record(entry)` entry has { mode, arm, exemption: string|null,
 *    outcome: 'exempt'|'eligible'|'control'|'denied'|'answered'|'failed_open',
 *    checklistVersion?, itemIds? }.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/staged-self-review.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createVerifyGuardHook } from '../../src/verify-guard';

const load = () => import('../../src/staged-self-review');
const pre = (tool_input: Record<string, unknown>) =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'mcp__buildd__buildd_work', tool_input: { action: 'complete_task', params: {}, ...tool_input }, cwd: '/wt' }) as any;
const completion = (params: Record<string, unknown> = { summary: 'done' }) => pre({ params });
const denied = (r: any) => r?.hookSpecificOutput?.permissionDecision === 'deny';
const reasonOf = (r: any): string => r?.hookSpecificOutput?.permissionDecisionReason ?? '';

const TASK = {
  id: 't-1',
  title: 'Fix the off-by-one in pager',
  description: 'Fix the off-by-one in paginate(). Every caller of paginate must be covered.',
  pathManifest: ['src/pager.ts'],
  outputRequirement: 'pr_required',
  category: 'bug',
  roleSlug: 'builder',
  specCriterionIds: ['AC-1'],
  kind: 'builder',
};

async function setup(over: Record<string, unknown> = {}, taskOver: Record<string, unknown> = {}) {
  const m = await load();
  const records: any[] = [];
  const hook = m.createStagedSelfReviewHook({
    worker: { id: 'w-1' },
    task: { ...TASK, ...taskOver },
    mode: 'acting',
    arm: 'treatment',
    propensity: 0.5,
    openFailures: () => [],
    record: (e: any) => records.push(e),
    log: () => {},
    ...over,
  } as any);
  return { m, hook, records };
}

describe('R-1 / AC-1: a separate module that never weakens verify-guard', () => {
  test('R-1: the stage lives in its own module and verify-guard does not import it', () => {
    const guard = readFileSync(new URL('../../src/verify-guard.ts', import.meta.url), 'utf8');
    expect(guard).not.toMatch(/staged-self-review/);
    return load().then(m => expect(typeof m.createStagedSelfReviewHook).toBe('function'));
  });

  test('AC-1: a failed last run is refused by verify-guard first and the stage does not fire', async () => {
    const open = [{ family: 'test', exitCode: 1 }] as any;
    const guard = createVerifyGuardHook({ worker: { id: 'w-1' }, isReviewer: false, openFailures: () => open, log: () => {} });
    const { hook, records } = await setup({ openFailures: () => open });
    const input = completion();
    const g = await guard(input);
    expect(denied(g)).toBe(true);
    // Even if the stage were asked, it yields to the red run and spends no once-only.
    const s = await hook(input);
    expect(denied(s)).toBe(false);
    expect(records.some(r => r.outcome === 'denied')).toBe(false);
    // After recovery the stage still has its one shot.
    const { hook: hook2 } = await setup();
    expect(denied(await hook2(input))).toBe(true);
  });
});

describe('R-3 / AC-2: fires at most once per worker', () => {
  test('AC-2: first success completion is denied once with the checklist; the second is not', async () => {
    const { hook, records } = await setup();
    const first = await hook(completion());
    expect(denied(first)).toBe(true);
    expect(reasonOf(first).length).toBeGreaterThan(20);
    expect(reasonOf(first)).toMatch(/scope|requirement/i);
    const second = await hook(completion({ summary: 'done, answered' }));
    expect(denied(second)).toBe(false);
    expect(records.filter(r => r.outcome === 'denied')).toHaveLength(1);
  });

  test('R-3: a hook rebuilt for the same worker after answering does not stage again', async () => {
    const { hook, records } = await setup();
    await hook(completion());
    await hook(completion());
    const m = await load();
    const again = m.createStagedSelfReviewHook({
      worker: { id: 'w-1' }, task: TASK, mode: 'acting', arm: 'treatment', openFailures: () => [],
      record: (e: any) => records.push(e), log: () => {}, alreadyStaged: true,
    } as any);
    expect(denied(await again(completion()))).toBe(false);
  });
});

describe('R-3 / AC-3: exemptions never deny and log the reason', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['error report', { params: { error: 'could not do it' } }, {}],
    ['blockedOnTaskId', { params: { blockedOnTaskId: 'other', summary: 'x' } }, {}],
    ['discardEdits', { params: { discardEdits: true, summary: 'x' } }, {}],
    ['reviewer task', { params: { summary: 'x' } }, { kind: 'reviewer' }],
    ['visual-auditor task', { params: { summary: 'x' } }, { kind: 'visual_auditor' }],
    ['bookkeeping task', { params: { summary: 'x' } }, { kind: 'bookkeeping' }],
    ['planning task', { params: { summary: 'x' } }, { kind: 'planning' }],
    ['alreadyShippedIn', { params: { alreadyShippedIn: 12, summary: 'x' } }, {}],
    ['output requirement none', { params: { summary: 'x' } }, { outputRequirement: 'none' }],
  ];
  for (const [name, input, taskOver] of cases) {
    test(`AC-3: ${name} is never denied and logs exempt:<reason>`, async () => {
      const { hook, records } = await setup({}, taskOver);
      const r = await hook(pre(input));
      expect(denied(r)).toBe(false);
      const exempt = records.find(e => e.outcome === 'exempt');
      expect(exempt?.exemption).toMatch(/^exempt:\S+/);
      expect(records.some(e => e.outcome === 'denied')).toBe(false);
    });
  }

  test('R-3: the Codex backend has no stage (exempt:codex)', async () => {
    const { hook, records } = await setup({ backend: 'codex' });
    expect(denied(await hook(completion()))).toBe(false);
    expect(records.find(e => e.outcome === 'exempt')?.exemption).toBe('exempt:codex');
  });
});

describe('R-4 / AC-4: recording mode computes and logs, never asks', () => {
  test('AC-4: recording accepts the call exactly as with the stage off and logs the checklist', async () => {
    const { hook, records } = await setup({ mode: 'recording' });
    expect(await hook(completion())).toEqual({});
    const e = records.find(r => r.outcome === 'eligible');
    expect(e).toBeTruthy();
    expect(e.mode).toBe('recording');
    expect(e.itemIds.length).toBeGreaterThan(0);
    expect(typeof e.checklistVersion).toBe('string');
  });
});

describe('R-5 / AC-6: control arm sees no stage', () => {
  test('AC-6: acting mode, control arm: no checklist shown, logged as control', async () => {
    const { hook, records } = await setup({ arm: 'control' });
    expect(await hook(completion())).toEqual({});
    expect(records.find(r => r.outcome === 'control')?.arm).toBe('control');
    expect(records.some(r => r.outcome === 'denied')).toBe(false);
  });
});

describe('R-2 / AC-5: the checklist asks about intent only', () => {
  const BANNED = /\b(tests?|typecheck|type-check|lint|build|pull request|PR\b|diff|CI\b|verification command|green|passes|passing)\b/i;

  test('AC-5: no item mentions tests, typecheck, lint, build, PR, diff, CI or the verification command', async () => {
    const m = await load();
    for (const t of [TASK, { ...TASK, pathManifest: ['**'], specCriterionIds: [] }, { ...TASK, description: 'Update the docs.' }]) {
      const c = m.buildIntentChecklist(t as any);
      expect(c.items.length).toBeGreaterThan(0);
      for (const item of c.items) expect(item.text).not.toMatch(BANNED);
    }
  });

  test('R-2: built from the task alone: scope, every-requirement and summary-claim items, spec ids, deterministic across calls', async () => {
    const m = await load();
    const a = m.buildIntentChecklist(TASK as any);
    const b = m.buildIntentChecklist({ ...TASK } as any);
    expect(a).toEqual(b);
    const text = a.items.map(i => i.text).join('\n');
    expect(text).toMatch(/src\/pager\.ts/); // path manifest shown as input
    expect(text).toMatch(/AC-1/); // pinned criterion id
    expect(a.items.some(i => /every|all/i.test(i.text))).toBe(true); // sibling coverage
    expect(a.items.some(i => /summary|claim/i.test(i.text))).toBe(true); // overclaim
    expect(new Set(a.items.map(i => i.id)).size).toBe(a.items.length);
  });
});

describe('R-10 / AC-7: fails open', () => {
  test('AC-7: a checklist build that throws lets the call proceed and logs the failure', async () => {
    const logs: string[] = [];
    const { hook, records } = await setup({ buildChecklist: () => { throw new Error('boom'); }, log: (l: string) => logs.push(l) });
    expect(denied(await hook(completion()))).toBe(false);
    expect(records.find(r => r.outcome === 'failed_open')).toBeTruthy();
    expect(logs.join('\n')).toMatch(/boom/);
  });

  test('R-10: a state-read failure also fails open', async () => {
    const { hook } = await setup({ openFailures: () => { throw new Error('state gone'); } });
    expect(denied(await hook(completion()))).toBe(false);
  });
});

describe('R-9: no model call in the first release', () => {
  test('R-9: the module imports no model client or fetch', () => {
    const src = readFileSync(new URL('../../src/staged-self-review.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/@anthropic-ai|openai|\bfetch\(|invoke_model_inference|query\(/);
  });
});

describe('R-6: what a staged task records', () => {
  test('R-6: the answered record carries checklist, answers, tool calls between, added turns/tokens, change flag', async () => {
    const { hook, records, m } = await setup();
    await hook(completion());
    m.noteStagedToolCall?.('w-1', 'Bash');
    await hook(completion({ summary: 'ok', structuredOutput: { selfReview: [{ id: 'x', answer: 'met', evidence: 'because' }] } }));
    const e = records.find(r => r.outcome === 'answered');
    expect(e).toBeTruthy();
    for (const k of ['checklistVersion', 'itemIds', 'answers', 'toolCallsBetween', 'addedTurns', 'addedTokens', 'workChangedAfterDenial']) {
      expect(k in e).toBe(true);
    }
  });
});

describe('resolveStagedConfig (AC-2 wiring)', () => {
  const exp = { id: 'e1', policyVersion: 1, treatmentFraction: 1 };
  test('acting + experiment + fraction 1 draws treatment', async () => {
    const m = await load();
    expect(m.resolveStagedConfig({ selfReview: 'acting', selfReviewExperiment: exp }, 'task-1')).toMatchObject({ mode: 'acting', arm: 'treatment' });
  });
  test('acting without an experiment never treats', async () => {
    const m = await load();
    expect(m.resolveStagedConfig({ selfReview: 'acting' }, 'task-1').arm).toBe('control');
  });
  test('claimed workspace experiment reaches the draw (fetched config has none)', async () => {
    const m = await load();
    // getWorkspaceConfig never carries the experiment; the claim response does.
    const fetched = { selfReview: 'acting' };
    const claimed = { selfReview: 'acting', selfReviewExperiment: exp };
    expect(m.resolveStagedConfig(fetched, 'task-1').arm).toBe('control');
    const merged = m.stagedGitConfig(fetched, claimed);
    expect(m.resolveStagedConfig(merged, 'task-1')).toMatchObject({ mode: 'acting', arm: 'treatment', propensity: 1 });
  });
  test('stagedGitConfig keeps the fetched config when the claim has no experiment', async () => {
    const m = await load();
    const fetched = { selfReview: 'acting' };
    expect(m.stagedGitConfig(fetched, undefined)).toBe(fetched);
    expect(m.stagedGitConfig(fetched, { selfReview: 'acting' })).toBe(fetched);
  });
  test('recording is never treatment; absent is off', async () => {
    const m = await load();
    expect(m.resolveStagedConfig({ selfReview: 'recording', selfReviewExperiment: exp }, 't').arm).toBe('control');
    expect(m.resolveStagedConfig({}, 't').mode).toBe('off');
  });
});
