import { describe, expect, it } from 'bun:test';
import { buildStageAFacts, type StageAFacts, type StageASource } from '../post-session-quality';
import {
  POST_SESSION_TRIAGE_CAPABILITY,
  POST_SESSION_TRIAGE_PROMPT_VERSION,
  POST_SESSION_TRIAGE_QUESTIONS,
  TRIAGE_REASON_CODES,
  TRIAGE_UNAVAILABLE,
  buildTriageState,
  deriveTriageSignals,
  evaluateHardTriggers,
  postSessionTriagePromptHash,
  readTriageAnswers,
  resolveTriageOutcome,
  unavailableTriage,
} from '../post-session-triage';
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
    expect(INFERENCE_CAPABILITIES[POST_SESSION_TRIAGE_CAPABILITY]?.kind).toBe('built_in');
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

describe('deriveTriageSignals / buildTriageState', () => {
  it('derives small booleans and counters', () => {
    const s = deriveTriageSignals(facts({ src: { ciFixAttempts: 1, attempts: { attemptNumber: 2, totalAttempts: 2 } } }));
    expect(s).toMatchObject({
      sessionFailed: false, retried: true, prShipped: true, merged: false,
      reviewRounds: 1, requestChanges: 0, ciFixAttempts: 1,
      recallCalls: 2, learnCalls: 1, errorTotal: 0, transcriptPresent: true,
    });
  });

  it('carries null for unknowns rather than zero', () => {
    const s = deriveTriageSignals(facts({ worker: { resultMeta: null }, src: { reviews: null, errorTraces: null } }));
    expect(s.recallCalls).toBeNull();
    expect(s.reviewRounds).toBeNull();
    expect(s.errorTotal).toBeNull();
  });

  it('state holds no ids, no free text, and stays small', () => {
    const state = buildTriageState(facts());
    const json = JSON.stringify(state);
    for (const id of ['worker-1', 'task-1', 'ws-1', 'mission-1']) expect(json).not.toContain(id);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('"prNumber"');
    expect(Buffer.byteLength(json)).toBeLessThan(4 * 1024);
    expect((state as any).signals).toBeDefined();
    expect((state as any).outcome.workerStatus).toBe('completed');
  });
});

describe('questions', () => {
  it('ask exactly the typed output fields, with the stable label sets', () => {
    expect(Object.keys(POST_SESSION_TRIAGE_QUESTIONS).sort()).toEqual(['decision', 'focus', 'reasonCode']);
    expect(Object.keys(POST_SESSION_TRIAGE_QUESTIONS.decision.criteria).sort()).toEqual(['analyse', 'skip']);
    expect(Object.keys(POST_SESSION_TRIAGE_QUESTIONS.focus.criteria).sort())
      .toEqual(['general', 'knowledge', 'orchestration', 'retrieval', 'review_merge', 'runtime']);
    expect(Object.keys(POST_SESSION_TRIAGE_QUESTIONS.reasonCode.criteria).sort()).toEqual([...TRIAGE_REASON_CODES].sort());
    expect(TRIAGE_REASON_CODES).not.toContain(TRIAGE_UNAVAILABLE);
  });

  it('prompt hash is pinned to the prompt version (bump the version when the prompt changes)', () => {
    expect(`${POST_SESSION_TRIAGE_PROMPT_VERSION}:${postSessionTriagePromptHash()}`).toBe('pst1:43768b8bbfb4');
  });
});

describe('readTriageAnswers', () => {
  const answers = {
    decision: { choice: 'analyse', confidence: 0.83, probabilities: {} },
    focus: { choice: 'retrieval', confidence: 0.6, probabilities: {} },
    reasonCode: { choice: 'retrieval_gap', confidence: 0.55, probabilities: {} },
  };

  it('maps a well-formed answer to an ok record with the decision confidence', () => {
    const r = readTriageAnswers(answers as any, { model: 'm-1', latencyMs: 120, attempts: 1 });
    expect(r).toMatchObject({ status: 'ok', decision: 'analyse', focus: 'retrieval', reasonCode: 'retrieval_gap', confidence: 0.83 });
    expect(r.provenance).toMatchObject({ promptVersion: POST_SESSION_TRIAGE_PROMPT_VERSION, model: 'm-1', latencyMs: 120 });
  });

  it('an off-vocabulary label or a bad confidence is malformed, recorded as unavailable', () => {
    const bad = readTriageAnswers({ ...answers, focus: { choice: 'vibes', confidence: 0.9 } } as any, { model: 'm', latencyMs: 1, attempts: 1 });
    expect(bad).toMatchObject({ status: 'unavailable', reasonCode: TRIAGE_UNAVAILABLE, decision: null });
    expect(bad.provenance?.error).toBe('malformed');
    const nan = readTriageAnswers({ ...answers, decision: { choice: 'skip', confidence: Number.NaN } } as any, { model: 'm', latencyMs: 1, attempts: 1 });
    expect(nan.status).toBe('unavailable');
    const missing = readTriageAnswers({ decision: answers.decision } as any, { model: 'm', latencyMs: 1, attempts: 1 });
    expect(missing.status).toBe('unavailable');
  });
});

describe('resolveTriageOutcome', () => {
  const ok = (decision: 'skip' | 'analyse') => ({
    status: 'ok' as const, decision, focus: 'general' as const, reasonCode: 'routine_success', confidence: 0.9,
  });

  it('follows the model when no hard trigger fires', () => {
    expect(resolveTriageOutcome(ok('skip'), [])).toMatchObject({ finalDecision: 'skip', rule: 'triage', hardTriggered: false });
    expect(resolveTriageOutcome(ok('analyse'), [])).toMatchObject({ finalDecision: 'analyse', rule: 'triage' });
  });

  it('a hard trigger overrides a model skip', () => {
    expect(resolveTriageOutcome(ok('skip'), ['reviewer_escalated']))
      .toMatchObject({ finalDecision: 'analyse', rule: 'hard_trigger', hardTriggered: true, hardTriggerReasons: ['reviewer_escalated'] });
  });

  it('unavailable triage fails open to skip, but hard triggers still apply', () => {
    const u = unavailableTriage('timeout', { latencyMs: 5000 });
    expect(u).toMatchObject({ status: 'unavailable', decision: null, reasonCode: TRIAGE_UNAVAILABLE });
    expect(resolveTriageOutcome(u, [])).toMatchObject({ finalDecision: 'skip', rule: 'fail_open_skip' });
    expect(resolveTriageOutcome(u, ['review_fix_loop'])).toMatchObject({ finalDecision: 'analyse', rule: 'hard_trigger' });
  });
});
