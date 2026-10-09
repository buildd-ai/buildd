import { describe, it, expect, mock } from 'bun:test';
import { runDecisionKind, type DecisionResponse, type DecisionRoute } from '@builddai/ai-kit/decide';
import { listBuilddDecisionKinds } from '@buildd/core/decision-kinds';
import { OPT_IN_CAPABILITIES, INFERENCE_CAPABILITIES } from '@buildd/core/inference-policy';
import {
  askMergeReadiness,
  interpretMergeReadiness,
  mergeReadinessKind,
  mergeReadinessOverride,
} from './merge-readiness-decision';
import { mergeAdviceDigest, type MergeAdviceRow } from './merge-advice-server';
import { mergeAdviceSubjectId, type MergeAdviceFacts, type MergeReadinessDecision } from './merge-advice';

const facts = (over: Partial<MergeAdviceFacts> = {}): MergeAdviceFacts => ({
  ci: 'green', review: 'escalated', reviewConfidence: 'high', reviewCoversHead: true, blockers: ['migration'],
  policyTier: 'agent-review', githubApprovalRequired: false, draft: false, refreshFirst: false, missionBlocked: false, ...over,
});

describe('the kind', () => {
  it('is a registered buildd kind on its own opt-in capability, live, with no escalation or challenger', () => {
    expect(listBuilddDecisionKinds().map(k => k.kind)).toContain('buildd.merge_readiness');
    expect(mergeReadinessKind.binding).toMatchObject({ capability: 'merge_readiness', mode: 'live' });
    expect(mergeReadinessKind.binding.escalation ?? null).toBeNull();
    expect(mergeReadinessKind.binding.challenger ?? null).toBeNull();
    expect(OPT_IN_CAPABILITIES).toContain('merge_readiness');
    expect(INFERENCE_CAPABILITIES.merge_readiness.kind).toBe('opt_in');
  });

  // The pin: a change to the questions or the decision set must be deliberate
  // (re-run an eval, bump policyVersion), never a side effect.
  it('is pinned', () => {
    expect(mergeReadinessKind.promptFingerprint).toBe('7894e2ab0dc0');
    expect(mergeReadinessKind.configFingerprint).toBe('e3cf881d03b6');
    expect([...mergeReadinessKind.decisions]).toEqual(['merge_now', 'wait', 'needs_human', 'request_changes']);
  });
});

describe('rules veto', () => {
  it.each([
    [{ refreshFirst: true }, 'wait', 'rule_refresh_first'],
    [{ missionBlocked: true }, 'wait', 'rule_mission_blocked'],
    [{ draft: true }, 'wait', 'rule_draft'],
    [{ ci: 'conflict' as const }, 'wait', 'rule_conflict'],
    [{ ci: 'running' as const }, 'wait', 'rule_ci_running'],
    [{ ci: 'fixing' as const }, 'wait', 'rule_ci_fixing'],
    [{ review: 'in_flight' as const }, 'wait', 'rule_review_in_flight'],
    [{ ci: 'failing' as const }, 'needs_human', 'rule_ci_failing'],
    [{ review: 'changes_requested' as const }, 'request_changes', 'rule_changes_requested'],
  ])('%p → %s', (over, decision, reasonCode) => {
    expect(mergeReadinessOverride(facts(over as Partial<MergeAdviceFacts>))).toEqual({ decision: decision as MergeReadinessDecision, reasonCode });
  });

  it('leaves only an unsettled PR to the model', () => {
    expect(mergeReadinessOverride(facts())).toBeNull();
  });

  it('never asks the model when a rule fires', async () => {
    const invoke = mock(async () => { throw new Error('must not be called'); });
    const route = { provider: 'openrouter', model: 'typesafe/jev-1.13', isMeasured: () => true, invoke } as unknown as DecisionRoute;
    const r = await runDecisionKind(mergeReadinessKind, { features: facts({ ci: 'running' }) }, { mode: 'live', cheap: route, escalation: null, unavailable: null });
    expect(r).toMatchObject({ source: 'rule', decision: 'wait' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('Jev only tightens', () => {
  it('keeps a merge_now the facts back', () => {
    expect(interpretMergeReadiness({ ready: { choice: 'merge_now', confidence: 0.9 } }, facts()))
      .toEqual({ decision: 'merge_now', confidence: 0.9, reasonCode: 'model_merge_now' });
  });

  it('turns a merge_now without green CI or a review of this commit into needs_human', () => {
    for (const over of [{ ci: 'unknown' as const }, { reviewCoversHead: false }, { review: 'none' as const }, { review: 'failed' as const }]) {
      expect(interpretMergeReadiness({ ready: { choice: 'merge_now', confidence: 0.99 } }, facts(over)))
        .toMatchObject({ decision: 'needs_human', reasonCode: 'model_merge_now_vetoed' });
    }
  });

  it('falls back to needs_human, whatever the cause', () => {
    for (const cause of ['disabled', 'no_provider', 'provider_failure', 'low_confidence'] as const) {
      expect(mergeReadinessKind.fallback(null, cause).decision).toBe('needs_human');
    }
  });
});

describe('askMergeReadiness', () => {
  const payload = { workspaceId: 'ws-1', prNumber: 7, headSha: 'head-1', taskId: 'task-1', facts: facts() };
  const response = (over: Partial<DecisionResponse<string, MergeReadinessDecision>> = {}) =>
    ({ decision: 'needs_human', source: 'model', reasonCode: 'model_needs_human', fallbackCause: null, ...over }) as DecisionResponse<string, MergeReadinessDecision>;

  it('asks once, as a pr_head subject in the workspace and task, and composes the line', async () => {
    const run = mock(async (_r: unknown, _s: unknown) => response());
    const r = await askMergeReadiness({ payload, teamId: 'team-1', userId: 'user-1' }, { run, findStored: async () => null, now: () => 0 });
    expect(r).toEqual({
      kind: 'answer', reused: false,
      advice: { decision: 'needs_human', source: 'model', line: 'Needs your judgement: migration.', at: new Date(0).toISOString(), stale: null },
    });
    expect(run.mock.calls[0]![0]).toMatchObject({ subjectRef: { type: 'pr_head', id: mergeAdviceSubjectId('ws-1', 7, 'head-1') } });
    expect(run.mock.calls[0]![1]).toEqual({ teamId: 'team-1', workspaceId: 'ws-1', taskId: 'task-1', userId: 'user-1' });
  });

  it('reuses a stored answer for the same head and facts without spending', async () => {
    const stored: MergeAdviceRow = {
      subjectId: mergeAdviceSubjectId('ws-1', 7, 'head-1'), fingerprint: mergeAdviceDigest(facts()),
      appliedAnswer: 'merge_now', reason: 'model:model_merge_now', failureClass: null, createdAt: new Date(0),
    };
    const run = mock(async () => response());
    const r = await askMergeReadiness({ payload, teamId: 'team-1', userId: 'user-1' }, { run, findStored: async () => stored });
    expect(r).toMatchObject({ kind: 'answer', reused: true, advice: { decision: 'merge_now', stale: null } });
    expect(run).not.toHaveBeenCalled();
  });

  it('shares one call between concurrent taps', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const run = mock(async () => { await gate; return response(); });
    const a = askMergeReadiness({ payload, teamId: 'team-1', userId: 'user-1' }, { run, findStored: async () => null });
    const b = askMergeReadiness({ payload, teamId: 'team-1', userId: 'user-2' }, { run, findStored: async () => null });
    release();
    await Promise.all([a, b]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('says why when the capability is off or there is no key, instead of showing the fallback as advice', async () => {
    const off = await askMergeReadiness({ payload: { ...payload, headSha: 'h-off' }, teamId: 't', userId: 'u' }, {
      findStored: async () => null, run: async () => response({ source: 'fallback', fallbackCause: 'disabled', reasonCode: 'fallback_disabled' }),
    });
    expect(off).toEqual({ kind: 'unavailable', reason: 'Merge readiness is off for this team. Turn it on in Settings → AI.' });
    const noKey = await askMergeReadiness({ payload: { ...payload, headSha: 'h-key' }, teamId: 't', userId: 'u' }, {
      findStored: async () => null, run: async () => response({ source: 'fallback', fallbackCause: 'no_provider', reasonCode: 'fallback_no_provider' }),
    });
    expect(noKey).toEqual({ kind: 'unavailable', reason: 'This team has no decision-model key.' });
  });
});
