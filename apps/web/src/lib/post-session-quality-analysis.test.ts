import { describe, expect, it } from 'bun:test';
import {
  FINDING_CLASSES,
  FINDING_PROPOSED_ACTIONS,
  FINDING_SEVERITIES,
  buildStageAFacts,
  type StageAFacts,
  type StageASource,
} from '@buildd/core/post-session-quality';
import { verificationSignature } from '@buildd/core/verification-check';
import type { CompletedSessionTranscript } from './session-transcript';
import {
  MAX_FINDINGS,
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
  POST_SESSION_ANALYSER_VERSION,
  POST_SESSION_CHECK_IDS,
  analysePostSession,
  analysePostSessionRun,
  postSessionEvidenceCoverage,
  type AnalysisRunRow,
  type PostSessionAnalysisDeps,
  type PostSessionAnalysisInput,
} from './post-session-quality-analysis';

const NOW = new Date('2026-10-04T12:00:00Z');

function source(over: {
  worker?: Partial<StageASource['worker']>;
  task?: Partial<StageASource['task']>;
  src?: Partial<StageASource>;
} = {}): StageASource {
  return {
    worker: {
      id: 'worker-1', status: 'completed', exitCause: null, error: null, turns: 12, inputTokens: 1000,
      outputTokens: 500, costUsd: '0.42', startedAt: new Date('2026-10-04T11:00:00Z'), completedAt: NOW,
      prNumber: 41, prLifecycleStatus: 'ci_green', mergedAt: null, supersededByPrNumber: null, abandonedAt: null,
      rejectedCompletionPayload: null, dirtyWorktree: false, mcpCallCount: 4,
      resultMeta: { toolCounts: { Read: 10, Edit: 2, mcp__buildd__recall: 2 } } as any,
      ...over.worker,
    },
    task: {
      id: 'task-1', status: 'completed', kind: 'engineering', category: 'feature', roleSlug: 'builder',
      missionId: 'mission-1', outputRequirement: 'pr_required', creationSource: 'mcp', parentTaskId: null,
      result: { summarySource: 'agent' },
      ...over.task,
    },
    workspace: { id: 'ws-1', mergePolicyTier: 'agent-review', dataClass: 'standard' },
    mode: 'shadow',
    attempts: { attemptNumber: 1, totalAttempts: 1 },
    reviews: [{ status: 'completed', verdict: 'approve', confidence: 0.9 }],
    ciFixAttempts: 0,
    errorTraces: [],
    transcript: { availability: 'present', sizeBytes: 1000 },
    corpora: { code: 'indexed', docs: 'indexed' },
    unavailable: [],
    ...over.src,
  };
}

const facts = (over: Parameters<typeof source>[0] = {}): StageAFacts => buildStageAFacts(source(over));

const call = (seq: number, name: string, input: Record<string, unknown> = {}) =>
  ({ type: 'tool_call', seq, toolCall: { name, input } });

function transcript(over: Partial<CompletedSessionTranscript> = {}): CompletedSessionTranscript {
  return {
    traceAvailability: 'full',
    source: { kind: 'session-diagnostics', objectKey: 'teams/t/ws/w/transcript.jsonl' },
    missingPortions: [],
    reason: null,
    records: [
      { type: 'session', schemaVersion: 1 },
      call(0, 'mcp__buildd__recall', { query: 'how does x work' }),
      call(1, 'Read', { file_path: 'a.ts' }),
      call(2, 'Edit', { file_path: 'a.ts' }),
    ],
    ...over,
  };
}

function input(over: Partial<PostSessionAnalysisInput> = {}): PostSessionAnalysisInput {
  return {
    runId: 'run-1',
    facts: facts(),
    focus: 'general',
    hardTriggerReasons: [],
    transcript: transcript(),
    evidence: [],
    knowledge: null,
    ...over,
  };
}

const analyse = (over: Partial<PostSessionAnalysisInput> = {}) => analysePostSession(input(over), NOW);
const checkResult = (a: ReturnType<typeof analyse>, id: string) => a.results.find(r => r.checkId === id)!;

describe('routine session', () => {
  it('passes every conclusive check and records one no-action finding', () => {
    const a = analyse();
    expect(a.analyserVersion).toBe(POST_SESSION_ANALYSER_VERSION);
    expect(a.results.map(r => r.checkId).sort()).toEqual([...POST_SESSION_CHECK_IDS].sort());
    expect(a.results.filter(r => r.verdict === 'fail')).toEqual([]);
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({ class: 'no_action', severity: 'low', proposedAction: 'observe_only' });
  });

  it('every result carries post-session provenance and the worker as subject', () => {
    for (const r of analyse().results) {
      expect(r.provenance.flavor).toBe('post_session_quality');
      expect(r.subject).toEqual({ kind: 'worker', ref: 'worker-1' });
    }
  });
});

describe('finding schema', () => {
  it('every finding is bounded and uses the persisted vocabularies', () => {
    const a = analyse({
      facts: facts({
        worker: { prNumber: null, prLifecycleStatus: null, rejectedCompletionPayload: { x: 1 }, dirtyWorktree: true },
        src: {
          errorTraces: [{ pattern: 'oom_killed', count: 3 }],
          reviews: [{ status: 'completed', verdict: 'escalate', confidence: 0.5 }],
        },
      }),
    });
    expect(a.findings.length).toBeGreaterThan(0);
    expect(a.findings.length).toBeLessThanOrEqual(MAX_FINDINGS);
    for (const f of a.findings) {
      expect(FINDING_CLASSES).toContain(f.class);
      expect(FINDING_SEVERITIES).toContain(f.severity);
      expect(FINDING_PROPOSED_ACTIONS).toContain(f.proposedAction);
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
      expect(f.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
      expect(f.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
      expect(f.signature).toMatch(/^[0-9a-f]+$/);
      expect(f.recurrenceKey.startsWith('post_session:')).toBe(true);
      expect(f.evidenceRefs).toContainEqual({ kind: 'post_session_run', ref: 'run-1' });
    }
  });

  it('never copies transcript content into a finding', () => {
    const t = transcript({
      records: [{ type: 'session', schemaVersion: 1 }, call(0, 'Edit', { file_path: 'secret-path.ts', new_string: 'sk-live-123' })],
    });
    const a = analyse({ transcript: t });
    expect(JSON.stringify(a.findings)).not.toContain('sk-live-123');
    expect(JSON.stringify(a.findings)).not.toContain('secret-path');
  });
});

describe('platform checks', () => {
  it('claimed success without the required PR is a high platform finding', () => {
    const a = analyse({ facts: facts({ worker: { prNumber: null, prLifecycleStatus: null } }) });
    const f = a.findings.find(x => x.checkId === 'success_has_shipping_evidence')!;
    expect(f).toMatchObject({ class: 'platform', severity: 'high', proposedAction: 'file_task' });
  });

  it('merge after a reviewer rejection is critical', () => {
    const a = analyse({
      facts: facts({
        worker: { prLifecycleStatus: 'merged', mergedAt: NOW },
        src: { reviews: [{ status: 'completed', verdict: 'request-changes', confidence: 0.9 }] },
      }),
    });
    expect(a.findings[0]).toMatchObject({ checkId: 'merge_agrees_with_review', severity: 'critical', class: 'platform' });
  });

  it('merge on a failed task is high, not critical', () => {
    const a = analyse({ facts: facts({ worker: { prLifecycleStatus: 'merged', mergedAt: NOW }, task: { status: 'failed' } }) });
    expect(a.findings.find(f => f.checkId === 'merge_agrees_with_review')!.severity).toBe('high');
  });

  it('output gate refusing finished work is a platform finding', () => {
    const a = analyse({ facts: facts({ worker: { rejectedCompletionPayload: { a: 1 } } }) });
    expect(a.findings.find(f => f.checkId === 'output_contract_honoured')).toMatchObject({ class: 'platform', severity: 'high' });
  });
});

describe('environment checks', () => {
  it('a recurring severe error is one environment finding whose signature names the pattern, not the run', () => {
    const one = analyse({ facts: facts({ src: { errorTraces: [{ pattern: 'oom_killed', count: 3 }] } }) });
    const other = analyse({
      runId: 'run-2',
      facts: facts({ worker: { id: 'worker-2' }, task: { id: 'task-2' }, src: { errorTraces: [{ pattern: 'oom_killed', count: 2 }] } }),
    });
    const a = one.findings.find(f => f.checkId === 'no_severe_runtime_error')!;
    const b = other.findings.find(f => f.checkId === 'no_severe_runtime_error')!;
    expect(a.class).toBe('environment');
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toBe(verificationSignature(['no_severe_runtime_error', 'oom_killed']));
    expect(a.evidenceRefs).toContainEqual({ kind: 'error_trace', ref: 'oom_killed' });
  });

  it('a different severe pattern is a different signature but the same recurrence family', () => {
    const a = analyse({ facts: facts({ src: { errorTraces: [{ pattern: 'oom_killed', count: 3 }] } }) }).findings[0];
    const b = analyse({ facts: facts({ src: { errorTraces: [{ pattern: 'bwrap_namespace_denied', count: 3 }] } }) }).findings[0];
    expect(a.signature).not.toBe(b.signature);
    expect(a.recurrenceKey).toBe(b.recurrenceKey);
  });
});

describe('root cause over symptoms', () => {
  it('a review loop caused by a severe runtime error reports the runtime error, with the loop as related', () => {
    const a = analyse({
      facts: facts({
        src: {
          errorTraces: [{ pattern: 'oom_killed', count: 4 }],
          ciFixAttempts: 3,
        },
      }),
    });
    const ids = a.findings.map(f => f.checkId);
    expect(ids).toContain('no_severe_runtime_error');
    expect(ids).not.toContain('review_converges');
    expect(a.findings.find(f => f.checkId === 'no_severe_runtime_error')!.relatedCheckIds).toContain('review_converges');
    // the symptom's result is still recorded
    expect(checkResult(a, 'review_converges').verdict).toBe('fail');
  });

  it('an escalation on a PR that then merged reports the merge, not the escalation', () => {
    const a = analyse({
      facts: facts({
        worker: { prLifecycleStatus: 'merged', mergedAt: NOW },
        src: { reviews: [{ status: 'completed', verdict: 'escalate', confidence: 0.6 }] },
      }),
    });
    expect(a.findings.map(f => f.checkId)).toEqual(['merge_agrees_with_review']);
  });

  it('caps findings and orders by severity', () => {
    const a = analyse({
      facts: facts({
        worker: { prNumber: null, prLifecycleStatus: null, rejectedCompletionPayload: { a: 1 }, dirtyWorktree: true },
        src: {
          errorTraces: [{ pattern: 'oom_killed', count: 3 }],
          reviews: [{ status: 'completed', verdict: 'escalate', confidence: 0.5 }],
        },
      }),
      knowledge: { claims: [{ sourceId: 'mem-1', claim: 'x shipped', contradictedBy: { kind: 'pr', ref: '9' } }] },
    });
    expect(a.findings.length).toBe(MAX_FINDINGS);
    const ranks = a.findings.map(f => FINDING_SEVERITIES.indexOf(f.severity));
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
  });
});

describe('failure explanation', () => {
  it('an unexplained failure is a low-confidence platform observation', () => {
    const a = analyse({ facts: facts({ worker: { status: 'failed', prNumber: null, prLifecycleStatus: null }, task: { status: 'failed' } }) });
    expect(a.findings.find(f => f.checkId === 'failure_explained')).toMatchObject({ class: 'platform', proposedAction: 'observe_only' });
  });

  it('a failure with an exit cause is explained', () => {
    const a = analyse({ facts: facts({ worker: { status: 'failed', exitCause: 'budget_exhausted' }, task: { status: 'failed' } }) });
    expect(checkResult(a, 'failure_explained').verdict).toBe('pass');
  });

  it('unread error traces make it inconclusive, never "unexplained"', () => {
    const a = analyse({
      facts: facts({ worker: { status: 'failed' }, task: { status: 'failed' }, src: { errorTraces: null } }),
    });
    expect(checkResult(a, 'failure_explained').verdict).toBe('inconclusive');
    expect(a.findings.some(f => f.checkId === 'failure_explained')).toBe(false);
  });
});

describe('transcript coverage rules', () => {
  const noRecallFirst = [
    { type: 'session', schemaVersion: 1 },
    call(0, 'Read', { file_path: 'a.ts' }),
    call(1, 'Edit', { file_path: 'a.ts' }),
    call(2, 'mcp__buildd__recall', { query: 'late' }),
  ];

  it('with a full trace, editing before any recall is asserted', () => {
    const a = analyse({ transcript: transcript({ records: noRecallFirst }) });
    const f = a.findings.find(x => x.checkId === 'retrieval_before_first_edit')!;
    expect(f).toMatchObject({ class: 'agent_use', severity: 'low' });
    expect(f.evidenceRefs).toContainEqual({ kind: 'transcript', ref: 'teams/t/ws/w/transcript.jsonl' });
  });

  it('recall before the first edit passes', () => {
    expect(checkResult(analyse(), 'retrieval_before_first_edit').verdict).toBe('pass');
  });

  it('when corpora were not indexed the same pattern is a retrieval finding, not agent misuse', () => {
    const a = analyse({
      facts: facts({ src: { corpora: { code: 'not_indexed', docs: 'not_indexed' } } }),
      transcript: transcript({ records: noRecallFirst }),
    });
    expect(a.findings.find(x => x.checkId === 'retrieval_before_first_edit')!.class).toBe('retrieval');
  });

  it('a trailing-only trace (early calls evicted) is inconclusive — the same records are NOT asserted', () => {
    const a = analyse({
      transcript: transcript({ traceAvailability: 'truncated', missingPortions: ['early_tool_calls'], records: noRecallFirst }),
    });
    expect(checkResult(a, 'retrieval_before_first_edit').verdict).toBe('inconclusive');
    expect(a.findings.some(f => f.checkId === 'retrieval_before_first_edit')).toBe(false);
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({ class: 'no_action', proposedAction: 'observe_only' });
    expect(a.findings[0].title.toLowerCase()).toContain('inconclusive');
  });

  it('unknown coverage or dropped records also block early-session claims', () => {
    for (const portion of ['unknown_coverage', 'malformed_records'] as const) {
      const a = analyse({ transcript: transcript({ traceAvailability: 'truncated', missingPortions: [portion], records: noRecallFirst }) });
      expect(checkResult(a, 'retrieval_before_first_edit').verdict).toBe('inconclusive');
    }
  });

  it('a tail-only truncation still has the early session, so the claim stands', () => {
    const a = analyse({ transcript: transcript({ traceAvailability: 'truncated', missingPortions: ['tail'], records: noRecallFirst }) });
    expect(checkResult(a, 'retrieval_before_first_edit').verdict).toBe('fail');
  });

  it('an absent transcript is inconclusive; a transcript that was never read is unsupported', () => {
    const absent = analyse({ transcript: transcript({ traceAvailability: 'absent', source: null, records: [], reason: 'object_missing' }) });
    expect(checkResult(absent, 'retrieval_before_first_edit').verdict).toBe('inconclusive');
    const unread = analyse({ transcript: null });
    expect(checkResult(unread, 'retrieval_before_first_edit').verdict).toBe('unsupported');
  });

  it('reports coverage in the shape the run row stores', () => {
    const a = analyse({ transcript: transcript({ traceAvailability: 'truncated', missingPortions: ['early_tool_calls', 'tail'] }) });
    expect(a.coverage).toEqual({
      traceAvailability: 'truncated',
      traceSource: 'session-diagnostics',
      traceMissing: { portions: ['early_tool_calls', 'tail'], reason: null },
    });
    expect(analyse({ transcript: null }).coverage.traceAvailability).toBe('absent');
  });

  it('postSessionEvidenceCoverage never reports an absent source as complete', () => {
    const cov = postSessionEvidenceCoverage(input({ transcript: null, evidence: null, facts: facts({ src: { errorTraces: null, reviews: null } }) }));
    expect(cov['transcript.early_tool_calls']).toBe('absent');
    expect(cov['facts.errors']).toBe('absent');
    expect(cov['facts.review']).toBe('absent');
    expect(cov['evidence.objects']).toBe('absent');
    expect(cov['knowledge.claims']).toBe('absent');
  });
});

describe('knowledge', () => {
  it('a retrieved claim contradicted by shipped state proposes a correction — it does not write memory', () => {
    const a = analyse({
      knowledge: { claims: [{ sourceId: 'mem-1', claim: 'feature X shipped in PR 9', contradictedBy: { kind: 'pr', ref: '9' } }] },
    });
    const f = a.findings.find(x => x.checkId === 'retrieved_knowledge_consistent')!;
    expect(f).toMatchObject({ class: 'knowledge', proposedAction: 'propose_memory_correction', severity: 'high' });
    expect(f.evidenceRefs).toContainEqual({ kind: 'memory', ref: 'mem-1' });
    expect(f.evidenceRefs).toContainEqual({ kind: 'pr', ref: '9' });
    expect(f.signature).toBe(verificationSignature(['retrieved_knowledge_consistent', 'mem-1']));
  });

  it('without reconstructable knowledge context the check is unsupported', () => {
    expect(checkResult(analyse({ knowledge: null }), 'retrieved_knowledge_consistent').verdict).toBe('unsupported');
  });
});

describe('analysePostSessionRun (read-only orchestration)', () => {
  function row(over: Partial<AnalysisRunRow> = {}): AnalysisRunRow {
    return {
      id: 'run-1', state: 'triaged', workerId: 'worker-1', taskId: 'task-1', workspaceId: 'ws-1',
      facts: facts(), triage: { status: 'ok', decision: 'analyse', focus: 'retrieval', reasonCode: 'retrieval_gap', confidence: 0.7 },
      hardTriggerReasons: [],
      ...over,
    };
  }

  function deps(over: Partial<PostSessionAnalysisDeps> = {}): PostSessionAnalysisDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      loadRun: async id => { calls.push(`loadRun:${id}`); return row(); },
      readTranscript: async w => { calls.push(`readTranscript:${w}`); return transcript(); },
      listEvidence: async t => { calls.push(`listEvidence:${t.id}`); return [{ id: 'ev-1', kind: 'ci_job_log' }]; },
      loadKnowledge: async () => { calls.push('loadKnowledge'); return null; },
      now: NOW,
      ...over,
    };
  }

  it('reads run, transcript, evidence and knowledge, and returns the analysis without writing', async () => {
    const d = deps();
    const r = await analysePostSessionRun('run-1', d);
    expect(r.status).toBe('analysed');
    if (r.status !== 'analysed') throw new Error('unreachable');
    expect(r.analysis.focus).toBe('retrieval');
    expect(d.calls).toEqual(['loadRun:run-1', 'readTranscript:worker-1', 'listEvidence:task-1', 'loadKnowledge']);
    // The deps surface has no write hook at all.
    expect(Object.keys(d).filter(k => /record|write|insert|update|create|save/i.test(k))).toEqual([]);
  });

  it('only analyses triaged runs', async () => {
    const r = await analysePostSessionRun('run-1', deps({ loadRun: async () => row({ state: 'skipped' }) }));
    expect(r).toEqual({ status: 'not_ready', runId: 'run-1', state: 'skipped' });
  });

  it('missing run', async () => {
    expect(await analysePostSessionRun('nope', deps({ loadRun: async () => null }))).toEqual({ status: 'missing' });
  });

  it('a transcript or evidence read failure degrades coverage, it does not fail the analysis', async () => {
    const r = await analysePostSessionRun('run-1', deps({
      readTranscript: async () => { throw new Error('r2 down'); },
      listEvidence: async () => { throw new Error('db hiccup'); },
    }));
    expect(r.status).toBe('analysed');
    if (r.status !== 'analysed') throw new Error('unreachable');
    expect(r.analysis.coverage.traceAvailability).toBe('absent');
    expect(r.analysis.results.find(x => x.checkId === 'retrieval_before_first_edit')!.verdict).toBe('unsupported');
  });

  it('never throws: a load failure is an error status with a bounded message', async () => {
    const r = await analysePostSessionRun('run-1', deps({ loadRun: async () => { throw new Error('x'.repeat(2000)); } }));
    expect(r.status).toBe('error');
    if (r.status !== 'error') throw new Error('unreachable');
    expect(r.error.length).toBeLessThanOrEqual(500);
  });

  it('a run with no facts is not ready', async () => {
    const r = await analysePostSessionRun('run-1', deps({ loadRun: async () => row({ facts: null }) }));
    expect(r.status).toBe('not_ready');
  });
});
