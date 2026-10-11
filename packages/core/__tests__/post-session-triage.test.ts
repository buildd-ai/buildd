import { describe, expect, it } from 'bun:test';
import { buildStageAFacts, type StageAFacts, type StageASource } from '../post-session-quality';
import {
  TRIAGE_UNAVAILABLE,
  buildTriageFeatures,
  evaluateHardTriggers,
  resolveTriageOutcome,
  triageRecordFromResponse,
  unavailableTriage,
} from '../post-session-triage';
import { parsePostSessionTriageFeatures, postSessionTriageKind } from '../decision-kind-post-session-triage';
import { INFERENCE_CAPABILITIES } from '../inference-policy';

const NOW = new Date('2026-10-03T12:00:00Z');

function source(over: {
  worker?: Partial<StageASource['worker']>;
  task?: Partial<StageASource['task']>;
  src?: Partial<StageASource>;
} = {}): StageASource {
  return {
    worker: {
      id: 'worker-1', status: 'completed', exitCause: null, error: null, turns: 12, inputTokens: 1000,
      outputTokens: 500, costUsd: '0.42', startedAt: new Date('2026-10-03T11:00:00Z'), completedAt: NOW,
      prNumber: 41, prLifecycleStatus: 'ci_green', mergedAt: null, supersededByPrNumber: null, abandonedAt: null,
      rejectedCompletionPayload: null, dirtyWorktree: false, mcpCallCount: 4,
      resultMeta: { toolCounts: { Read: 10, mcp__buildd__recall: 2, mcp__buildd__learn: 1 } } as any,
      ...over.worker,
    },
    task: {
      id: 'task-1', status: 'completed', kind: 'engineering', category: 'feature', roleSlug: 'builder',
      missionId: 'mission-1', outputRequirement: 'pr_required', creationSource: 'mcp', parentTaskId: null,
      result: { summarySource: 'agent', summary: 'SECRET summary text' },
      ...over.task,
    },
    workspace: { id: 'ws-1', mergePolicyTier: 'agent-review', dataClass: 'standard' },
    mode: 'shadow',
    attempts: { attemptNumber: 1, totalAttempts: 1 },
    reviews: [{ status: 'completed', verdict: 'approve', confidence: 0.9 }],
    ciFixAttempts: 0,
    errorTraces: [],
    transcript: { availability: 'present', sizeBytes: null },
    corpora: { code: 'indexed', docs: 'indexed' },
    unavailable: [],
    ...over.src,
  };
}

const facts = (over: Parameters<typeof source>[0] = {}): StageAFacts => buildStageAFacts(source(over));

describe('capability', () => {
  it('is registered in the inference policy as a built-in', () => {
    expect(INFERENCE_CAPABILITIES[postSessionTriageKind.binding.capability as keyof typeof INFERENCE_CAPABILITIES]?.kind).toBe('built_in');
  });
});

describe('evaluateHardTriggers', () => {
  it('a routine green session triggers nothing', () => {
    expect(evaluateHardTriggers(facts())).toEqual([]);
  });

  it('reviewer escalation', () => {
    const f = facts({ src: { reviews: [{ status: 'completed', verdict: 'escalate', confidence: 0.8 }] } });
    expect(evaluateHardTriggers(f)).toContain('reviewer_escalated');
  });

  it('repeated request-changes is a fix loop; a single round is not', () => {
    const one = facts({ src: { reviews: [{ status: 'completed', verdict: 'request-changes', confidence: 0.8 }] } });
    expect(evaluateHardTriggers(one)).not.toContain('review_fix_loop');
    const two = facts({ src: { reviews: [
      { status: 'completed', verdict: 'request-changes', confidence: 0.8 },
      { status: 'completed', verdict: 'request-changes', confidence: 0.8 },
    ] } });
    expect(evaluateHardTriggers(two)).toContain('review_fix_loop');
  });

  it('repeated CI-fix rounds are a fix loop', () => {
    expect(evaluateHardTriggers(facts({ src: { ciFixAttempts: 2 } }))).not.toContain('review_fix_loop');
    expect(evaluateHardTriggers(facts({ src: { ciFixAttempts: 3 } }))).toContain('review_fix_loop');
  });

  it('output-gate refusal after work was produced; not when nothing was produced', () => {
    const withPr = facts({ worker: { exitCause: 'output_unmet', status: 'failed' } });
    expect(evaluateHardTriggers(withPr)).toContain('output_contract_after_work');
    const dirty = facts({ worker: { exitCause: 'output_unmet', status: 'failed', prNumber: null, dirtyWorktree: true } });
    expect(evaluateHardTriggers(dirty)).toContain('output_contract_after_work');
    const nothing = facts({ worker: { exitCause: 'output_unmet', status: 'failed', prNumber: null, dirtyWorktree: false } });
    expect(evaluateHardTriggers(nothing)).not.toContain('output_contract_after_work');
  });

  it('contradictory PR/review/merge state', () => {
    const mergedOverRequestChanges = facts({
      worker: { prLifecycleStatus: 'merged', mergedAt: NOW },
      src: { reviews: [{ status: 'completed', verdict: 'request-changes', confidence: 0.9 }] },
    });
    expect(evaluateHardTriggers(mergedOverRequestChanges)).toContain('contradictory_pr_state');
    const mergedAndAbandoned = facts({ worker: { mergedAt: NOW, abandonedAt: NOW } });
    expect(evaluateHardTriggers(mergedAndAbandoned)).toContain('contradictory_pr_state');
    const mergedButTaskFailed = facts({ worker: { mergedAt: NOW }, task: { status: 'failed' } });
    expect(evaluateHardTriggers(mergedButTaskFailed)).toContain('contradictory_pr_state');
    expect(evaluateHardTriggers(facts({ worker: { mergedAt: NOW } }))).not.toContain('contradictory_pr_state');
  });

  it('a severe error signature recurring in the session; one occurrence or a benign slug is not', () => {
    expect(evaluateHardTriggers(facts({ src: { errorTraces: [{ pattern: 'oom_killed', count: 2 }] } })))
      .toContain('severe_error_recurring');
    expect(evaluateHardTriggers(facts({ src: { errorTraces: [{ pattern: 'oom_killed', count: 1 }] } })))
      .not.toContain('severe_error_recurring');
    expect(evaluateHardTriggers(facts({ src: { errorTraces: [{ pattern: 'cd_no_such_file', count: 9 }] } })))
      .not.toContain('severe_error_recurring');
  });

  it('a completed PR-required task with no PR claims success without shipping evidence', () => {
    expect(evaluateHardTriggers(facts({ worker: { prNumber: null, prLifecycleStatus: null }, src: { reviews: [] } })))
      .toContain('success_without_evidence');
    // Not required to ship a PR: no claim to check.
    expect(evaluateHardTriggers(facts({ worker: { prNumber: null }, task: { outputRequirement: 'none' }, src: { reviews: [] } })))
      .not.toContain('success_without_evidence');
    // Failed, not claiming success.
    expect(evaluateHardTriggers(facts({ worker: { prNumber: null, status: 'failed' }, task: { status: 'failed' }, src: { reviews: [] } })))
      .not.toContain('success_without_evidence');
  });

  it('an unread source never fires a trigger (missing evidence is not negative evidence)', () => {
    const f = facts({ src: { reviews: null, ciFixAttempts: null, errorTraces: null } });
    expect(evaluateHardTriggers(f)).toEqual([]);
  });

  it('is deterministic and ordered', () => {
    const f = facts({
      worker: { mergedAt: NOW, abandonedAt: NOW },
      src: { reviews: [{ status: 'completed', verdict: 'escalate', confidence: 0.5 }] },
    });
    expect(evaluateHardTriggers(f)).toEqual(['reviewer_escalated', 'contradictory_pr_state']);
  });
});

describe('buildTriageFeatures', () => {
  it('derives small booleans and counters the kind accepts', () => {
    const f = buildTriageFeatures(facts({ src: { ciFixAttempts: 1, attempts: { attemptNumber: 2, totalAttempts: 2 } } }));
    expect(f).toMatchObject({
      sessionFailed: false, retried: true, prShipped: true, merged: false,
      reviewRounds: 1, requestChanges: 0, ciFixAttempts: 1, errorTotal: 0, transcriptPresent: true, hardTriggers: [],
    });
    expect(parsePostSessionTriageFeatures(f).ok).toBe(true);
  });

  it('carries null for unknowns rather than zero', () => {
    const f = buildTriageFeatures(facts({ src: { reviews: null, errorTraces: null } }));
    expect(f.reviewRounds).toBeNull();
    expect(f.errorTotal).toBeNull();
  });

  it('holds no ids, no free text, and carries the fired hard triggers', () => {
    const f = buildTriageFeatures(facts({ src: { reviews: [{ status: 'completed', verdict: 'escalate', confidence: 0.9 }] } }));
    const json = JSON.stringify(f);
    for (const id of ['worker-1', 'task-1', 'ws-1', 'mission-1', 'SECRET']) expect(json).not.toContain(id);
    expect(f.hardTriggers).toEqual(['reviewer_escalated']);
  });
});

describe('triageRecordFromResponse', () => {
  const base = {
    kind: 'buildd.post_session_triage', policyVersion: 'p', model: 'm-1', latencyMs: 120, attempts: [{}], mode: 'live',
    fallbackCause: null,
  } as const;

  it('a model answer is an ok record with its focus and confidence', () => {
    const r = triageRecordFromResponse({ ...base, decision: 'analyse', source: 'model', confidence: 0.83, reasonCode: 'focus_retrieval' } as any);
    expect(r).toMatchObject({ status: 'ok', decision: 'analyse', focus: 'retrieval', reasonCode: 'focus_retrieval', confidence: 0.83 });
    expect(r.provenance).toMatchObject({ model: 'm-1', latencyMs: 120, source: 'model' });
  });

  it('a hard-trigger rule is its own status, with no model confidence', () => {
    const r = triageRecordFromResponse({ ...base, decision: 'analyse', source: 'rule', confidence: null, reasonCode: 'hard_trigger_review_fix_loop', attempts: [] } as any);
    expect(r).toMatchObject({ status: 'rule', decision: 'analyse', focus: null, confidence: null });
  });

  it('a fallback applies no decision, even when a model answered below the threshold', () => {
    const r = triageRecordFromResponse({ ...base, decision: 'skip', source: 'fallback', confidence: null, reasonCode: 'fallback_low_confidence', fallbackCause: 'low_confidence' } as any);
    expect(r).toMatchObject({ status: 'unavailable', decision: null, focus: null, reasonCode: 'fallback_low_confidence' });
    expect(r.provenance).toMatchObject({ fallbackCause: 'low_confidence' });
  });
});

describe('resolveTriageOutcome', () => {
  const ok = { status: 'ok' as const, decision: 'skip' as const, focus: 'general' as const, reasonCode: 'focus_general', confidence: 0.9 };

  it('names the rule that produced the final decision', () => {
    expect(resolveTriageOutcome(ok, 'skip', [])).toMatchObject({ finalDecision: 'skip', rule: 'triage', hardTriggered: false });
    const rule = { ...ok, status: 'rule' as const, decision: 'analyse' as const };
    expect(resolveTriageOutcome(rule, 'analyse', ['reviewer_escalated']))
      .toMatchObject({ finalDecision: 'analyse', rule: 'hard_trigger', hardTriggered: true, hardTriggerReasons: ['reviewer_escalated'] });
  });

  it('unavailable triage fails open to skip, but hard triggers still apply', () => {
    const u = unavailableTriage('timeout', { latencyMs: 5000 });
    expect(u).toMatchObject({ status: 'unavailable', decision: null, reasonCode: TRIAGE_UNAVAILABLE });
    expect(resolveTriageOutcome(u, 'skip', [])).toMatchObject({ finalDecision: 'skip', rule: 'fail_open_skip' });
    expect(resolveTriageOutcome(u, 'analyse', ['review_fix_loop'])).toMatchObject({ finalDecision: 'analyse', rule: 'hard_trigger' });
  });
});
