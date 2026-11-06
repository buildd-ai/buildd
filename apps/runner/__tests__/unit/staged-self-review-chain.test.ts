/**
 * End-to-end style: the registered PreToolUse chain (verify guard, then the
 * staged entries from stagedSelfReviewPreToolUse, which workers.ts spreads)
 * denies the first success complete_task on the treatment arm in acting mode
 * and passes the second.
 */
import { describe, test, expect } from 'bun:test';
import { resolveStagedConfig, stagedSelfReviewPreToolUse } from '../../src/staged-self-review';
import { createVerifyGuardHook } from '../../src/verify-guard';

describe('registered chain: deny once, then pass (acting, treatment)', () => {
  const task = { id: 't1', title: 'Fix pager', description: 'Fix the off-by-one in paginate(). Cover every caller.' };
  const complete = (summary = 'done') => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__buildd__buildd_work',
    tool_input: { action: 'complete_task', params: { summary } },
  });
  // Same assembly the runner uses: verify guard first, then the staged entries.
  const chain = (cfgSource: any, isCodexTask = false) => {
    const cfg = resolveStagedConfig(cfgSource, 't1');
    const records: any[] = [];
    const worker = { id: 'w-chain' };
    const entries = [
      { hooks: [createVerifyGuardHook({ worker, isReviewer: false, openFailures: () => [], log: () => {} })] },
      ...stagedSelfReviewPreToolUse({
        cfg, isCodexTask, worker, task, record: e => records.push(e),
        hookOverrides: { openFailures: () => [], log: () => {} },
      }),
    ];
    const run = async (input: any) => {
      for (const e of entries) for (const h of e.hooks) {
        const out: any = await (h as any)(input);
        if (out?.hookSpecificOutput?.permissionDecision === 'deny') return out;
      }
      return {};
    };
    return { run, records, entries };
  };
  const exp = { id: 'exp1', policyVersion: 1, treatmentFraction: 1 };

  test('first success complete_task is denied, second passes', async () => {
    const { run, records } = chain({ selfReview: 'acting', selfReviewExperiment: exp });
    const first: any = await run(complete());
    expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(JSON.stringify(first)).toContain('structuredOutput.selfReview');
    expect(await run(complete())).toEqual({});
    expect(await run(complete())).toEqual({});
    expect(records.map(r => r.outcome)).toEqual(['denied', 'answered']);
  });
  test('non-complete tool calls are never denied', async () => {
    const { run } = chain({ selfReview: 'acting', selfReviewExperiment: exp });
    expect(await run({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} })).toEqual({});
  });
  test('control arm, recording mode, and Codex register nothing that denies', async () => {
    for (const [cfg, codex] of [
      [{ selfReview: 'acting', selfReviewExperiment: { ...exp, treatmentFraction: 0 } }, false],
      [{ selfReview: 'recording', selfReviewExperiment: exp }, false],
      [{ selfReview: 'acting', selfReviewExperiment: exp }, true],
    ] as const) {
      const { run } = chain(cfg, codex);
      expect(await run(complete())).toEqual({});
    }
  });
});
