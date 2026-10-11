import { describe, it, expect } from 'bun:test';
import {
  MERGEABLE_AS_IS_REASON,
  MODEL_SHOW_MIN_P,
  NO_CALL_REASON,
  canAssess,
  confidenceBucket,
  diffSizeBucket,
  mergeAdviceLine,
  mergeAdviceSubjectId,
  mergeCiState,
  mergePolicyTier,
  mergeableAsIsByRule,
  parseLedgerReason,
  parseMergeAdviceFacts,
  parseMergeAdviceSubjectId,
  ruleAdviceView,
  ruleAnswer,
  type MergeAdviceFacts,
} from './merge-advice';

const facts =(over: Partial<MergeAdviceFacts> = {}): MergeAdviceFacts => ({
  ci: 'green', review: 'escalated', reviewConfidence: 'high', reviewCoversHead: true, blockers: ['migration'],
  policyTier: 'agent-review', githubApprovalRequired: false, draft: false, refreshFirst: false, missionBlocked: false,
  escalationCause: 'policy', diffSize: 'medium', ...over,
});

describe('parseMergeAdviceFacts', () => {
  it('accepts the closed fact set and canonicalises blocker order', () => {
    const r = parseMergeAdviceFacts({ ...facts(), blockers: ['security', 'migration', 'security'] });
    expect(r).toEqual({ ok: true, features: facts({ blockers: ['migration', 'security'] }) });
  });

  it('refuses anything that is not an enum or a boolean, including prose', () => {
    expect(parseMergeAdviceFacts('the reviewer said it was fine').ok).toBe(false);
    expect(parseMergeAdviceFacts({ ...facts(), ci: 'mostly green' }).ok).toBe(false);
    expect(parseMergeAdviceFacts({ ...facts(), blockers: ['a free-text reason'] }).ok).toBe(false);
    expect(parseMergeAdviceFacts({ ...facts(), draft: 'no' }).ok).toBe(false);
    expect(parseMergeAdviceFacts({ ...facts(), policyTier: 'yolo' }).ok).toBe(false);
  });

  it('drops extra keys, so a diff smuggled into the facts never reaches the model', () => {
    const r = parseMergeAdviceFacts({ ...facts(), diff: '+ secret' });
    expect(r.ok && 'diff' in r.features).toBe(false);
  });
});

describe('fact derivation', () => {
  it('reads CI from the lifecycle, with the card gate and a conflict outranking it', () => {
    expect(mergeCiState({ prLifecycleStatus: 'ci_green' })).toBe('green');
    expect(mergeCiState({ prLifecycleStatus: 'ci_running' })).toBe('running');
    expect(mergeCiState({ prLifecycleStatus: 'pr_open' })).toBe('running');
    expect(mergeCiState({ prLifecycleStatus: 'ci_failed', ciGateKind: 'fixing' })).toBe('fixing');
    expect(mergeCiState({ prLifecycleStatus: 'ci_failed', ciGateKind: 'blocked' })).toBe('failing');
    expect(mergeCiState({ prLifecycleStatus: 'ci_green', mergeConflict: true })).toBe('conflict');
    expect(mergeCiState({ prLifecycleStatus: null })).toBe('unknown');
  });

  it('buckets confidence and maps unknown tiers', () => {
    expect([confidenceBucket(0.9), confidenceBucket(0.6), confidenceBucket(0.2), confidenceBucket(null)]).toEqual(['high', 'medium', 'low', 'none']);
    expect(mergePolicyTier('human')).toBe('human');
    expect(mergePolicyTier('something-new')).toBe('other');
  });

  it('round-trips the ledger subject', () => {
    const id = mergeAdviceSubjectId('ws-1', 42, 'abc123');
    expect(parseMergeAdviceSubjectId(id)).toEqual({ workspaceId: 'ws-1', prNumber: 42, headSha: 'abc123' });
    expect(parseMergeAdviceSubjectId('task:whatever')).toBeNull();
  });

  it('reads the source and reason code off a ledger reason', () => {
    expect(parseLedgerReason('rule:rule_ci_running')).toEqual({ source: 'rule', reasonCode: 'rule_ci_running' });
    expect(parseLedgerReason('model:model_merge_now; chain=cheap')).toEqual({ source: 'model', reasonCode: 'model_merge_now' });
    expect(parseLedgerReason('nonsense')).toBeNull();
  });
});

describe('diffSizeBucket', () => {
  it('buckets lines changed, with unreported counts unknown', () => {
    expect([diffSizeBucket(40, 10), diffSizeBucket(300, 50), diffSizeBucket(600, 100), diffSizeBucket(900, 200)])
      .toEqual(['small', 'medium', 'large', 'xl']);
    expect(diffSizeBucket(null, null)).toBe('unknown');
    expect(diffSizeBucket(0, 0)).toBe('unknown');
  });

  it('refuses facts without a cause or a size', () => {
    expect(parseMergeAdviceFacts({ ...facts(), escalationCause: 'vibes' }).ok).toBe(false);
    expect(parseMergeAdviceFacts({ ...facts(), diffSize: 'huge' }).ok).toBe(false);
  });
});

describe('mergeableAsIsByRule', () => {
  it('holds for a policy-only escalation with green CI, a review of this commit, not a draft, not XL', () => {
    expect(mergeableAsIsByRule(facts())).toBe(true);
  });

  it('needs every condition', () => {
    expect(mergeableAsIsByRule(facts({ escalationCause: 'reviewer' }))).toBe(false);
    expect(mergeableAsIsByRule(facts({ ci: 'running' }))).toBe(false);
    expect(mergeableAsIsByRule(facts({ reviewCoversHead: false }))).toBe(false);
    expect(mergeableAsIsByRule(facts({ draft: true }))).toBe(false);
    expect(mergeableAsIsByRule(facts({ diffSize: 'xl' }))).toBe(false);
    expect(mergeableAsIsByRule(facts({ diffSize: 'unknown' }))).toBe(false);
    expect(mergeableAsIsByRule(facts({ refreshFirst: true }))).toBe(false);
  });
});

describe('ruleAnswer', () => {
  it('a blocking state outranks "mergeable as-is"', () => {
    expect(ruleAnswer(facts({ refreshFirst: true }))).toEqual({ decision: 'wait', reasonCode: 'rule_refresh_first' });
    expect(ruleAnswer(facts({ ci: 'failing' }))).toEqual({ decision: 'needs_human', reasonCode: 'rule_ci_failing' });
  });

  it('answers "mergeable as-is" when the rule holds, and nothing otherwise', () => {
    expect(ruleAnswer(facts())).toEqual({ decision: 'merge_now', reasonCode: MERGEABLE_AS_IS_REASON });
    expect(ruleAnswer(facts({ escalationCause: 'reviewer' }))).toBeNull();
  });
});

describe('mergeAdviceLine', () => {
  it('names the rule that settled it, first', () => {
    expect(mergeAdviceLine({ reasonCode: MERGEABLE_AS_IS_REASON, probability: null, facts: facts() }))
      .toBe('From the PR state: looks mergeable as-is.');
    expect(mergeAdviceLine({ reasonCode: MERGEABLE_AS_IS_REASON, probability: 0.1, facts: facts({ githubApprovalRequired: true }) }))
      .toBe('From the PR state: looks mergeable as-is. Approve it on GitHub.');
    expect(mergeAdviceLine({ reasonCode: 'rule_ci_running', probability: 0.9, facts: facts() })).toBe('Wait: CI is still running.');
    expect(mergeAdviceLine({ reasonCode: 'rule_ci_failing', probability: null, facts: facts() })).toBe('Needs you: CI is failing and no fix is running.');
  });

  it('shows the model’s yes only at the display threshold', () => {
    expect(mergeAdviceLine({ reasonCode: NO_CALL_REASON, probability: MODEL_SHOW_MIN_P, facts: facts() }))
      .toBe('Model: looks safe to merge as-is.');
    expect(mergeAdviceLine({ reasonCode: NO_CALL_REASON, probability: MODEL_SHOW_MIN_P - 0.01, facts: facts() })).toBeNull();
  });

  it('says nothing when there is nothing to say, and never names a model in the sentence', () => {
    expect(mergeAdviceLine({ reasonCode: NO_CALL_REASON, probability: null, facts: facts() })).toBeNull();
    expect(mergeAdviceLine({ reasonCode: 'fallback_provider_failure', probability: null, facts: facts() })).toBeNull();
    expect(mergeAdviceLine({ reasonCode: NO_CALL_REASON, probability: 0.9, facts: facts() })).not.toContain('Jev');
  });
});

describe('ruleAdviceView / canAssess', () => {
  const at = '2026-10-01T00:00:00.000Z';

  it('derives an unrecorded rule answer that still offers Assess, so the model gets asked', () => {
    const view = ruleAdviceView(facts(), at)!;
    expect(view).toMatchObject({ source: 'rule', reasonCode: MERGEABLE_AS_IS_REASON, recorded: false, line: 'From the PR state: looks mergeable as-is.' });
    expect(canAssess(view)).toBe(true);
  });

  it('a blocking rule settles it without offering Assess', () => {
    const view = ruleAdviceView(facts({ ci: 'running' }), at)!;
    expect(view.line).toBe('Wait: CI is still running.');
    expect(canAssess(view)).toBe(false);
  });

  it('no rule, no view; a recorded fresh answer offers nothing; a stale one offers Re-assess', () => {
    expect(ruleAdviceView(facts({ escalationCause: 'reviewer' }), at)).toBeNull();
    expect(canAssess(null)).toBe(true);
    const recorded = { ...ruleAdviceView(facts(), at)!, recorded: true };
    expect(canAssess(recorded)).toBe(false);
    expect(canAssess({ ...recorded, stale: 'new_commits' })).toBe(true);
  });
});
