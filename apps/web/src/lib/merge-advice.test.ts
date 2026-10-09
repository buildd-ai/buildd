import { describe, it, expect } from 'bun:test';
import {
  confidenceBucket,
  mergeAdviceLine,
  mergeAdviceSubjectId,
  mergeCiState,
  mergePolicyTier,
  parseLedgerReason,
  parseMergeAdviceFacts,
  parseMergeAdviceSubjectId,
  type MergeAdviceFacts,
} from './merge-advice';

const facts =(over: Partial<MergeAdviceFacts> = {}): MergeAdviceFacts => ({
  ci: 'green', review: 'escalated', reviewConfidence: 'high', reviewCoversHead: true, blockers: ['migration'],
  policyTier: 'agent-review', githubApprovalRequired: false, draft: false, refreshFirst: false, missionBlocked: false, ...over,
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

describe('mergeAdviceLine', () => {
  it('names the rule that settled it', () => {
    expect(mergeAdviceLine('wait', 'rule', 'rule_refresh_first', facts())).toBe('Wait: the branch refresh has to merge first.');
    expect(mergeAdviceLine('wait', 'rule', 'rule_ci_running', facts())).toBe('Wait: CI is still running.');
    expect(mergeAdviceLine('needs_human', 'rule', 'rule_ci_failing', facts())).toBe('Needs you: CI is failing and no fix is running.');
  });

  it('composes Jev answers from the facts, never from model prose', () => {
    expect(mergeAdviceLine('needs_human', 'model', 'model_needs_human', facts({ blockers: ['migration', 'security'] })))
      .toBe('Needs your judgement: migration, security.');
    expect(mergeAdviceLine('merge_now', 'model', 'model_merge_now', facts({ githubApprovalRequired: true })))
      .toBe('Looks safe to merge: CI is green and the review covers this commit. Approve it on GitHub.');
  });

  it('says so when no answer could be made', () => {
    expect(mergeAdviceLine('needs_human', 'fallback', 'fallback_low_confidence', facts())).toBe('Jev could not call this one. Decide from the review.');
  });
});
