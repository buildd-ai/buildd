import { describe, it, expect, mock } from 'bun:test';
import { runDecisionKind, type DecisionResponse, type DecisionRoute } from '@builddai/ai-kit/decide';
import { listBuilddDecisionKinds } from '@buildd/core/decision-kinds';
import { toDecisionLedgerInput } from '@buildd/core/decision-policy';
import { OPT_IN_CAPABILITIES, INFERENCE_CAPABILITIES } from '@buildd/core/inference-policy';
import {
  adviceViewFromResponse,
  askMergeReadiness,
  interpretMergeReadiness,
  mergeReadinessFallback,
  mergeReadinessKind,
  mergeReadinessOverride,
  mergeReadinessState,
} from './merge-readiness-decision';
import { mergeAdviceDigest, type MergeAdviceRow } from './merge-advice-server';
import {
  MERGEABLE_AS_IS_REASON,
  NO_CALL_REASON,
  mergeAdviceSubjectId,
  type MergeAdviceFacts,
  type MergeReadinessDecision,
} from './merge-advice';

const facts = (over: Partial<MergeAdviceFacts> = {}): MergeAdviceFacts => ({
  ci: 'green', review: 'escalated', reviewConfidence: 'high', reviewCoversHead: true, blockers: ['migration'],
  policyTier: 'agent-review', githubApprovalRequired: false, draft: false, refreshFirst: false, missionBlocked: false,
  escalationCause: 'reviewer', diffSize: 'medium', ...over,
});

/** A route whose model answers "safe as-is?" with probability `p`. */
function routeAnswering(p: number) {
  const invoke = mock(async () => ({
    ok: true as const,
    answers: { safe: { type: 'noul', noul: p } } as never,
    model: 'example/decider-1',
    usage: { inputTokens: 10, outputTokens: 1, costUsd: null },
    latencyMs: 5,
    attempts: 1,
  }));
  const route = { provider: 'openrouter', model: 'example/decider', isMeasured: () => true, invoke } as unknown as DecisionRoute;
  return { route, invoke };
}

describe('the kind', () => {
  it('is a registered buildd kind on its own opt-in capability, in shadow, with no escalation or challenger', () => {
    expect(listBuilddDecisionKinds().map(k => k.kind)).toContain('buildd.merge_readiness');
    expect(mergeReadinessKind.binding).toMatchObject({ capability: 'merge_readiness', mode: 'shadow' });
    expect(mergeReadinessKind.binding.escalation ?? null).toBeNull();
    expect(mergeReadinessKind.binding.challenger ?? null).toBeNull();
    expect(OPT_IN_CAPABILITIES).toContain('merge_readiness');
    expect(INFERENCE_CAPABILITIES.merge_readiness.kind).toBe('opt_in');
  });

  it('asks one yes/no question, never the four-label one', () => {
    expect(Object.keys(mergeReadinessKind.questions)).toEqual(['safe']);
    expect(mergeReadinessKind.questions.safe.type).toBe('noul');
  });

  // The pin: a change to the questions or the decision set must be deliberate
  // (re-run an eval, bump policyVersion), never a side effect.
  it('is pinned', () => {
    expect(mergeReadinessKind.promptFingerprint).toBe('8c97dd208a88');
    expect(mergeReadinessKind.configFingerprint).toBe('5f6363f15fc3');
    expect([...mergeReadinessKind.decisions]).toEqual(['merge_now', 'wait', 'needs_human', 'request_changes']);
  });

  it('gives the model short sentences, never a diff, a title or reviewer prose', () => {
    const state = mergeReadinessState(facts({ escalationCause: 'policy', githubApprovalRequired: true }));
    expect(state).toContain('only because the merge policy requires one');
    expect(state).toContain('CI is green.');
    expect(state).toContain('covers the current commit');
    expect(state).toContain('GitHub still requires an approval.');
  });
});

describe('rules first', () => {
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
  ])('%p → %s, with no model asked', async (over, decision, reasonCode) => {
    const f = facts(over as Partial<MergeAdviceFacts>);
    expect(mergeReadinessOverride(f)).toEqual({ decision: decision as MergeReadinessDecision, reasonCode });
    const { route, invoke } = routeAnswering(0.9);
    const r = await runDecisionKind(mergeReadinessKind, { features: f }, { mode: 'shadow', cheap: route, escalation: null, unavailable: null });
    expect(r).toMatchObject({ source: 'rule', decision });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('"mergeable as-is" is not an override: the model is still asked, and the rule is what applies', async () => {
    const f = facts({ escalationCause: 'policy' });
    expect(mergeReadinessOverride(f)).toBeNull();
    const { route, invoke } = routeAnswering(0.2);
    const r = await runDecisionKind(mergeReadinessKind, { features: f }, { mode: 'shadow', cheap: route, escalation: null, unavailable: null });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ source: 'fallback', decision: 'merge_now', reasonCode: MERGEABLE_AS_IS_REASON });
  });

  it('with no rule, a person decides and the card says nothing (no_call)', () => {
    expect(mergeReadinessFallback(facts(), 'shadow')).toEqual({ decision: 'needs_human', reasonCode: NO_CALL_REASON });
    expect(mergeReadinessFallback(null, 'disabled')).toEqual({ decision: 'needs_human', reasonCode: 'fallback_disabled' });
    expect(mergeReadinessFallback(facts({ escalationCause: 'policy' }), 'disabled').decision).toBe('merge_now');
  });
});

describe('the model answer is always recorded, applied never', () => {
  it('records the probability and the model that answered on the ledger row, applied=false', async () => {
    const { route } = routeAnswering(0.63);
    const r = await runDecisionKind(mergeReadinessKind, { features: facts(), subjectRef: { type: 'pr_head', id: 's' } }, { mode: 'shadow', cheap: route, escalation: null, unavailable: null });
    const row = toDecisionLedgerInput(r, { teamId: 't' });
    expect(row).toMatchObject({ verdict: 'merge_now', confidence: 0.63, model: 'example/decider-1', applied: false, appliedAnswer: 'needs_human' });
  });

  it('a yes the facts cannot back is recorded as needs_human, keeping the raw probability', () => {
    for (const over of [{ ci: 'unknown' as const }, { reviewCoversHead: false }, { review: 'none' as const }, { review: 'failed' as const }]) {
      expect(interpretMergeReadiness({ safe: { noul: 0.99 } }, facts(over)))
        .toEqual({ decision: 'needs_human', confidence: 0.99, reasonCode: 'model_vetoed_by_facts' });
    }
    expect(interpretMergeReadiness({ safe: { noul: 0.3 } }, facts()))
      .toEqual({ decision: 'merge_now', confidence: 0.3, reasonCode: 'model_safe_as_is' });
  });

  it('the card shows the model’s yes only at 0.4 or above, and nothing below', async () => {
    for (const [p, line] of [[0.55, 'Model: looks safe to merge as-is.'], [0.3, null]] as const) {
      const { route } = routeAnswering(p);
      const r = await runDecisionKind(mergeReadinessKind, { features: facts() }, { mode: 'shadow', cheap: route, escalation: null, unavailable: null });
      const view = adviceViewFromResponse(r, facts(), new Date(0).toISOString());
      expect(view.line).toBe(line);
      expect(view.model).toBe('example/decider-1');
      expect(view.recorded).toBe(true);
    }
  });
});

describe('askMergeReadiness', () => {
  const payload = { workspaceId: 'ws-1', prNumber: 7, headSha: 'head-1', taskId: 'task-1', facts: facts() };
  const response = (over: Partial<DecisionResponse<string, MergeReadinessDecision>> = {}) =>
    ({ decision: 'needs_human', source: 'fallback', reasonCode: NO_CALL_REASON, fallbackCause: 'shadow', attempts: [], ...over }) as DecisionResponse<string, MergeReadinessDecision>;

  it('asks once, as a pr_head subject in the workspace and task', async () => {
    const run = mock(async (_r: unknown, _s: unknown) => response());
    const r = await askMergeReadiness({ payload, teamId: 'team-1', userId: 'user-1' }, { run, findStored: async () => null, now: () => 0 });
    expect(r).toMatchObject({ kind: 'answer', reused: false, advice: { decision: 'needs_human', line: null, recorded: true, at: new Date(0).toISOString(), stale: null } });
    expect(run.mock.calls[0]![0]).toMatchObject({ subjectRef: { type: 'pr_head', id: mergeAdviceSubjectId('ws-1', 7, 'head-1') } });
    expect(run.mock.calls[0]![1]).toEqual({ teamId: 'team-1', workspaceId: 'ws-1', taskId: 'task-1', userId: 'user-1' });
  });

  it('reuses a stored answer for the same head and facts without spending', async () => {
    const stored: MergeAdviceRow = {
      subjectId: mergeAdviceSubjectId('ws-1', 7, 'head-1'), fingerprint: mergeAdviceDigest(facts()),
      appliedAnswer: 'needs_human', reason: `fallback:${NO_CALL_REASON}; cause=shadow`, failureClass: null,
      verdict: 'merge_now', confidence: 0.7, model: 'example/decider-1', createdAt: new Date(0),
    };
    const run = mock(async () => response());
    const r = await askMergeReadiness({ payload, teamId: 'team-1', userId: 'user-1' }, { run, findStored: async () => stored });
    expect(r).toMatchObject({ kind: 'answer', reused: true, advice: { line: 'Model: looks safe to merge as-is.', model: 'example/decider-1', stale: null } });
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

  it('says why when the capability is off or there is no key', async () => {
    const off = await askMergeReadiness({ payload: { ...payload, headSha: 'h-off' }, teamId: 't', userId: 'u' }, {
      findStored: async () => null, run: async () => response({ fallbackCause: 'disabled', reasonCode: 'fallback_disabled' }),
    });
    expect(off).toEqual({ kind: 'unavailable', reason: 'Merge readiness is off for this team. Turn it on in Settings → AI.' });
    const noKey = await askMergeReadiness({ payload: { ...payload, headSha: 'h-key' }, teamId: 't', userId: 'u' }, {
      findStored: async () => null, run: async () => response({ fallbackCause: 'no_provider', reasonCode: 'fallback_no_provider' }),
    });
    expect(noKey).toEqual({ kind: 'unavailable', reason: 'This team has no decision-model key.' });
  });

  it('still gives the rule answer when there is no model to ask', async () => {
    const r = await askMergeReadiness({ payload: { ...payload, headSha: 'h-rule', facts: facts({ escalationCause: 'policy' }) }, teamId: 't', userId: 'u' }, {
      findStored: async () => null,
      run: async () => response({ decision: 'merge_now', fallbackCause: 'disabled', reasonCode: MERGEABLE_AS_IS_REASON }),
    });
    expect(r).toMatchObject({ kind: 'answer', advice: { line: 'From the PR state: looks mergeable as-is.' } });
  });
});
