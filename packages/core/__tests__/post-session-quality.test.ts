import { describe, expect, it } from 'bun:test';
import {
  MAX_STAGE_A_FACTS_BYTES,
  MAX_TOP_TOOLS,
  buildStageAFacts,
  classifyToolCounts,
  isEligibleTerminalWorker,
  resolvePostSessionQualityMode,
  type StageASource,
} from '../post-session-quality';

const completedAt = new Date('2026-10-03T12:00:00Z');

function source(over: Partial<StageASource> = {}): StageASource {
  return {
    worker: {
      id: 'worker-a',
      status: 'completed',
      exitCause: null,
      error: null,
      turns: 42,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: '1.250000',
      startedAt: new Date('2026-10-03T11:30:00Z'),
      completedAt,
      prNumber: 12,
      prLifecycleStatus: 'ci_green',
      mergedAt: null,
      supersededByPrNumber: null,
      abandonedAt: null,
      rejectedCompletionPayload: null,
      dirtyWorktree: false,
      mcpCallCount: 7,
      resultMeta: {
        stopReason: 'end_turn',
        durationMs: 1,
        durationApiMs: 1,
        numTurns: 42,
        modelUsage: {},
        toolCounts: {
          Bash: 20,
          Read: 10,
          mcp__buildd__recall: 3,
          mcp__buildd__learn: 1,
          mcp__buildd__buildd: 5,
          'mcp__other__search': 2,
        },
      },
    },
    task: {
      id: 'task-a',
      status: 'completed',
      kind: 'engineering',
      category: 'feature',
      roleSlug: 'builder',
      missionId: 'mission-a',
      outputRequirement: 'pr_required',
      creationSource: 'orchestrator',
      parentTaskId: null,
      result: { summarySource: 'agent', summary: 'secret free text that must never leak' },
    },
    workspace: { id: 'ws-a', mergePolicyTier: 'agent-review', dataClass: 'standard' },
    mode: 'shadow',
    attempts: { attemptNumber: 1, totalAttempts: 1 },
    reviews: [],
    ciFixAttempts: 0,
    errorTraces: [],
    transcript: { availability: 'present', sizeBytes: null },
    corpora: { code: 'indexed', docs: 'not_indexed' },
    unavailable: [],
    ...over,
  };
}

describe('resolvePostSessionQualityMode', () => {
  it('defaults to shadow when config is absent', () => {
    expect(resolvePostSessionQualityMode(null)).toBe('shadow');
    expect(resolvePostSessionQualityMode(undefined)).toBe('shadow');
    expect(resolvePostSessionQualityMode({})).toBe('shadow');
    expect(resolvePostSessionQualityMode({ postSessionQuality: {} })).toBe('shadow');
  });

  it('honours off and propose', () => {
    expect(resolvePostSessionQualityMode({ postSessionQuality: { mode: 'off' } })).toBe('off');
    expect(resolvePostSessionQualityMode({ postSessionQuality: { mode: 'propose' } })).toBe('propose');
  });

  it('falls back to shadow for an unrecognised value rather than propose', () => {
    expect(resolvePostSessionQualityMode({ postSessionQuality: { mode: 'enforce' as never } })).toBe('shadow');
    expect(resolvePostSessionQualityMode({ postSessionQuality: 'propose' as never })).toBe('shadow');
  });
});

describe('isEligibleTerminalWorker', () => {
  const base = { status: 'completed', startedAt: completedAt, exitCause: null, taskId: 'task-a' };
  it('accepts a terminal worker that actually ran', () => {
    expect(isEligibleTerminalWorker(base)).toEqual({ eligible: true });
    expect(isEligibleTerminalWorker({ ...base, status: 'failed' })).toEqual({ eligible: true });
  });
  it('rejects live, never-started and taskless workers', () => {
    expect(isEligibleTerminalWorker({ ...base, status: 'running' })).toEqual({ eligible: false, reason: 'not_terminal' });
    expect(isEligibleTerminalWorker({ ...base, startedAt: null })).toEqual({ eligible: false, reason: 'never_started' });
    expect(isEligibleTerminalWorker({ ...base, exitCause: 'never_started' })).toEqual({ eligible: false, reason: 'never_started' });
    expect(isEligibleTerminalWorker({ ...base, taskId: null })).toEqual({ eligible: false, reason: 'no_task' });
  });
});

describe('classifyToolCounts', () => {
  it('counts Recall, Learn and Buildd tool families', () => {
    const c = classifyToolCounts({
      Bash: 4,
      mcp__buildd__recall: 3,
      mcp__buildd__learn: 2,
      mcp__buildd__buildd_memory: 1,
      mcp__buildd__buildd: 5,
      'mcp__other__trace': 2,
    });
    expect(c).toMatchObject({ known: true, total: 17, distinct: 6, recall: 3, learn: 3, buildd: 11 });
  });

  it('reports absence as unknown, never zero', () => {
    expect(classifyToolCounts(undefined)).toEqual({
      known: false, total: null, distinct: null, recall: null, learn: null, buildd: null, top: [],
    });
  });

  it('bounds the top list and tool-name length', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 60; i++) many[`tool_${i}_${'x'.repeat(300)}`] = i + 1;
    const c = classifyToolCounts(many);
    expect(c.top).toHaveLength(MAX_TOP_TOOLS);
    expect(c.top[0].count).toBe(60);
    for (const t of c.top) expect(t.tool.length).toBeLessThanOrEqual(80);
    expect(c.distinct).toBe(60);
  });
});

describe('buildStageAFacts', () => {
  it('assembles outcome, behaviour and context facts', () => {
    const facts = buildStageAFacts(source({
      reviews: [
        { status: 'completed', verdict: 'request-changes', confidence: 0.8 },
        { status: 'completed', verdict: 'approve', confidence: 0.9 },
      ],
      ciFixAttempts: 2,
      attempts: { attemptNumber: 2, totalAttempts: 3 },
    }));
    expect(facts.schemaVersion).toBe(1);
    expect(facts.outcome).toMatchObject({
      workerStatus: 'completed',
      taskStatus: 'completed',
      attemptNumber: 2,
      totalAttempts: 3,
      retried: true,
      prCreated: true,
      ciState: 'green',
      ciFixAttempts: 2,
      merged: false,
      outputGateRefused: false,
      summarySource: 'agent',
    });
    expect(facts.outcome.review).toEqual({
      rounds: 2,
      requestChangesCount: 1,
      escalated: false,
      failedRounds: 0,
      latestVerdict: 'approve',
      latestConfidence: 0.9,
    });
    expect(facts.behaviour).toMatchObject({
      turns: 42, inputTokens: 1000, outputTokens: 500, costUsd: 1.25, mcpCallCount: 7,
    });
    expect(facts.behaviour.tools).toMatchObject({ recall: 3, learn: 1, buildd: 9 });
    expect(facts.behaviour.durationMs).toBe(30 * 60 * 1000);
    expect(facts.context).toMatchObject({
      roleSlug: 'builder', taskKind: 'engineering', taskCategory: 'feature', missionId: 'mission-a',
      workspaceId: 'ws-a', mergePolicyTier: 'agent-review', qualityMode: 'shadow',
    });
    expect(facts.knowledge).toEqual({
      corpora: { code: 'indexed', docs: 'not_indexed' },
    });
    expect(facts.trace).toEqual({ transcript: 'present', transcriptSizeBytes: null, orderedTraceAvailable: false });
  });

  it('flags output-gate refusal, merge, escalation and contradictory shipping evidence', () => {
    const s = source();
    s.worker.rejectedCompletionPayload = { summary: 'x' };
    s.worker.exitCause = 'output_unmet';
    s.worker.prLifecycleStatus = 'merged';
    s.worker.mergedAt = completedAt;
    s.reviews = [{ status: 'completed', verdict: 'escalate', confidence: null }];
    const facts = buildStageAFacts(s);
    expect(facts.outcome.outputGateRefused).toBe(true);
    expect(facts.outcome.merged).toBe(true);
    expect(facts.outcome.ciState).toBe('merged');
    expect(facts.outcome.review.escalated).toBe(true);
  });

  it('reports unknown rather than zero when a source was unavailable', () => {
    const s = source({ reviews: null, ciFixAttempts: null, errorTraces: null, corpora: null, unavailable: ['reviews', 'ci_fixes', 'error_traces', 'corpora'] });
    s.worker.resultMeta = null;
    const facts = buildStageAFacts(s);
    expect(facts.outcome.review).toBeNull();
    expect(facts.outcome.ciFixAttempts).toBeNull();
    expect(facts.behaviour.tools.known).toBe(false);
    expect(facts.behaviour.tools.recall).toBeNull();
    expect(facts.errors).toBeNull();
    expect(facts.knowledge.corpora).toBeNull();
    expect(facts.unavailable).toEqual(['reviews', 'ci_fixes', 'error_traces', 'corpora']);
  });

  it('never carries free text — no summary, error message or transcript content', () => {
    const s = source();
    s.worker.error = 'Error: leaked stack trace with a token sk-live-123';
    s.worker.rejectedCompletionPayload = { summary: 'rejected free text' };
    s.errorTraces = [{ pattern: 'git_fatal', count: 3 }];
    const json = JSON.stringify(buildStageAFacts(s));
    expect(json).not.toContain('secret free text');
    expect(json).not.toContain('sk-live-123');
    expect(json).not.toContain('rejected free text');
    expect(json).toContain('git_fatal');
    const facts = buildStageAFacts(s);
    expect(facts.outcome.hasError).toBe(true);
  });

  it('stays within the byte budget for pathological inputs', () => {
    const s = source();
    const many: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) many[`mcp__x__${i}_${'y'.repeat(200)}`] = i;
    s.worker.resultMeta!.toolCounts = many;
    s.errorTraces = Array.from({ length: 500 }, (_, i) => ({ pattern: `p${i}_${'z'.repeat(300)}`, count: i }));
    s.reviews = Array.from({ length: 300 }, () => ({ status: 'completed', verdict: 'request-changes', confidence: 0.5 }));
    s.unavailable = Array.from({ length: 100 }, (_, i) => `src_${i}`);
    s.task.roleSlug = 'r'.repeat(5000);
    const facts = buildStageAFacts(s);
    expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThanOrEqual(MAX_STAGE_A_FACTS_BYTES);
    expect(facts.outcome.review!.rounds).toBe(300);
    expect(facts.errors!.patterns.length).toBeLessThanOrEqual(10);
  });
});
