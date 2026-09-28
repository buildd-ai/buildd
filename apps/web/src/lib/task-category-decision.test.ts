import { describe, it, expect, mock } from 'bun:test';

/**
 * The task category decision: Jev may fill or replace a keyword category when
 * confident, never a caller's or `review`, records one look per task, and can
 * never fail task creation. `decisionCall`, the keyword rules and the DB write
 * are injected, so nothing here reaches the DB or the network.
 */

const {
  categorizeTask,
  scheduleTaskCategorize,
  gateTaskCategory,
  taskCategoryPromptHash,
  buildTaskCategoryState,
  TASK_CATEGORY_QUESTIONS,
  TASK_CATEGORY_LABELS,
  TASK_CATEGORY_PROMPT_VERSION,
  DECISION_DESCRIPTION_CHARS,
  DECISION_TIMEOUT_MS,
  DECISION_LOG_PREFIX,
  FILL_MIN_CONFIDENCE,
  OVERRIDE_MIN_CONFIDENCE,
} = await import('./task-category-decision');

const INPUT = {
  taskId: 'task-1',
  teamId: 'team-1',
  workspaceId: 'ws-1',
  accountId: 'acct-1',
  title: 'Fix crash when saving settings',
  description: 'Saving throws a TypeError.',
  stored: 'bug' as const,
  callerSet: false,
};

function okResult(choice: string, confidence = 0.9) {
  return {
    ok: true as const,
    answers: { category: { type: 'choice' as const, choice, confidence, probabilities: { [choice]: confidence } } },
    model: 'typesafe/jev-1.13-20260917',
    usage: { inputTokens: 300, outputTokens: 20, costUsd: 0.0000126 },
    latencyMs: 210,
    attempts: 1,
  };
}

/** A recording write that wins unless told otherwise. */
function writer(wins = true) {
  const calls: Array<{ taskId: string; expected: unknown; category: unknown; record: any }> = [];
  const write = async (taskId: string, expected: any, category: any, record: any) => { calls.push({ taskId, expected, category, record }); return wins; };
  return { calls, write };
}

const deps = (decide: unknown, w = writer(), keyword: string | null = 'bug') => ({
  decide: decide as any, write: w.write, classify: () => keyword as any, log: () => {},
  now: () => new Date('2026-09-27T12:00:00Z'),
});

describe('TASK_CATEGORY_QUESTIONS', () => {
  it('offers every stored category, including review, and no catch-all', () => {
    const labels = Object.keys(TASK_CATEGORY_QUESTIONS.category.criteria).sort();
    expect(labels).toEqual([...TASK_CATEGORY_LABELS].sort());
    expect(labels).toContain('review');
    expect(labels).not.toContain('other');
  });

  it('has a research label, and review is scoped to an existing change so the two do not overlap', () => {
    const c = TASK_CATEGORY_QUESTIONS.category.criteria;
    expect(TASK_CATEGORY_LABELS).toContain('research');
    expect(c.research.what).toMatch(/report findings/i);
    expect(c.research.not_for).toMatch(/review/i);
    expect(c.research.not_for).toMatch(/bug/i);
    expect(c.review.what).toMatch(/pull request|diff|change/i);
    expect(c.review.not_for).toMatch(/research/i);
  });

  it('tells the model to follow definitions over title keywords', () => {
    expect(JSON.stringify(TASK_CATEGORY_QUESTIONS.category.instructions)).toMatch(/Follow the category definitions/);
  });
});

describe('buildTaskCategoryState', () => {
  it('truncates long descriptions', () => {
    const s = buildTaskCategoryState('t', 'x'.repeat(DECISION_DESCRIPTION_CHARS + 500));
    expect(s.task.description.length).toBe(DECISION_DESCRIPTION_CHARS + 1);
  });

  it('handles a missing description', () => {
    expect(buildTaskCategoryState(' t ', null)).toEqual({ task: { title: 't', description: '' } });
  });
});

describe('prompt version', () => {
  it('the prompt is pinned to its version: change a definition, bump the version and re-run the benchmark', () => {
    expect([TASK_CATEGORY_PROMPT_VERSION, taskCategoryPromptHash()]).toEqual(['tc1', '3850bae28633']);
  });
});

describe('gateTaskCategory', () => {
  const g = (over: Partial<Parameters<typeof gateTaskCategory>[0]>) =>
    gateTaskCategory({ stored: 'bug', callerSet: false, keyword: 'bug', decision: 'feature', confidence: 0.95, ...over });

  it('fills a blank at the fill gate, not below', () => {
    expect(g({ stored: null, keyword: null, confidence: FILL_MIN_CONFIDENCE })).toEqual({ category: 'feature', source: 'jev' });
    expect(g({ stored: null, keyword: null, confidence: FILL_MIN_CONFIDENCE - 0.01 })).toEqual({ category: null, source: 'keyword' });
  });

  it('replaces a keyword category only at the stricter override gate', () => {
    expect(g({ confidence: OVERRIDE_MIN_CONFIDENCE })).toEqual({ category: 'feature', source: 'jev' });
    expect(g({ confidence: 0.85 })).toEqual({ category: 'bug', source: 'keyword' });
  });

  it('never changes a caller\'s category, however confident', () => {
    expect(g({ callerSet: true, confidence: 1 })).toEqual({ category: 'bug', source: 'caller' });
  });

  it('never writes review and never replaces it: review is a behaviour flag', () => {
    expect(g({ stored: null, keyword: null, decision: 'review', confidence: 1 })).toEqual({ category: null, source: 'keyword' });
    expect(g({ stored: 'review', decision: 'bug', confidence: 1 })).toEqual({ category: 'review', source: 'keyword' });
  });
});

describe('categorizeTask', () => {
  it('records, but never applies, a pick from a team\'s own (non-Jev) decision model', async () => {
    const w = writer();
    const res = await categorizeTask({ ...INPUT, stored: null }, deps(async () => ({ ...okResult('feature', 0.99), model: 'qwen3-8b' }), w, null));
    expect(res.outcome).toBe('kept');
    expect(w.calls[0]).toMatchObject({ category: null, record: { jev: 'feature', source: 'keyword', v: 'tc1|qwen3-8b' } });
  });

  it('asks with a short deadline and the task text, and writes a confident fill with its provenance', async () => {
    const decide = mock(async () => okResult('docs', 0.93));
    const w = writer();
    const lines: string[] = [];
    const res = await categorizeTask({ ...INPUT, stored: null }, { ...deps(decide, w, null), log: l => lines.push(l) });

    const args = (decide.mock.calls[0] as any[])[0];
    expect(args.capability).toBe('task_category');
    expect(args.timeoutMs).toBe(DECISION_TIMEOUT_MS);
    expect(args.state).toEqual({ task: { title: INPUT.title, description: INPUT.description } });
    expect(res.outcome).toBe('applied');
    expect(w.calls).toEqual([{
      taskId: 'task-1', expected: null, category: 'docs',
      record: { v: 'tc1|typesafe/jev-1.13-20260917', source: 'jev', keyword: null, jev: 'docs', confidence: 0.93, at: '2026-09-27T12:00:00.000Z' },
    }]);
    expect(lines[0].startsWith(`${DECISION_LOG_PREFIX} `)).toBe(true);
    expect(lines[0]).not.toContain('crash');
    expect(lines[0]).not.toContain('TypeError');
  });

  it('below the gate it keeps the category but still records the look, so it is asked once', async () => {
    const w = writer();
    const res = await categorizeTask(INPUT, deps(async () => okResult('feature', 0.7), w));
    expect(res.outcome).toBe('kept');
    expect(w.calls[0]).toMatchObject({ expected: 'bug', category: 'bug', record: { source: 'keyword', jev: 'feature', confidence: 0.7 } });
  });

  it('a caller\'s category or a review task costs no call', async () => {
    for (const input of [{ ...INPUT, callerSet: true }, { ...INPUT, stored: 'review' as const }]) {
      const decide = mock(async () => okResult('bug'));
      const w = writer();
      await categorizeTask(input, deps(decide, w));
      expect(decide).not.toHaveBeenCalled();
      expect(w.calls[0].category).toBe(input.stored);
    }
  });

  it('a lost race (someone changed the row) reports it and changes nothing else', async () => {
    const res = await categorizeTask(INPUT, deps(async () => okResult('feature', 0.99), writer(false)));
    expect(res.outcome).toBe('lost_race');
  });

  it('not configured: records a retryable skip; a transient failure records nothing', async () => {
    const w = writer();
    const res = await categorizeTask(INPUT, deps(async () => ({ ok: false, error: { kind: 'missing_key' }, latencyMs: 0, attempts: 0 }), w));
    expect(res.outcome).toBe('skipped');
    expect(w.calls[0].record.skipped).toBe('unconfigured');

    const w2 = writer();
    const lines: string[] = [];
    const res2 = await categorizeTask(INPUT, {
      ...deps(async () => ({ ok: false, error: { kind: 'timeout', timeoutMs: 3000 }, latencyMs: 3000, attempts: 1 }), w2),
      log: l => lines.push(l),
    });
    expect(res2.outcome).toBe('error');
    expect(w2.calls).toHaveLength(0);
    expect(lines[0]).toContain('"error":"timeout"');
  });

  it('swallows a thrown error', async () => {
    const res = await categorizeTask(INPUT, deps(async () => { throw new Error('boom'); }));
    expect(res.outcome).toBe('error');
  });

  it('never sends a sensitive workspace\'s task content out', async () => {
    const decide = mock(async () => okResult('bug'));
    const w = writer();
    const res = await categorizeTask({ ...INPUT, dataClass: 'sensitive' }, deps(decide, w));
    expect(decide).not.toHaveBeenCalled();
    expect(res.outcome).toBe('skipped');
    expect(w.calls[0].record.skipped).toBe('sensitive');
  });
});

describe('scheduleTaskCategorize', () => {
  it('hands the run to the scheduler instead of running inline', async () => {
    const decide = mock(async () => okResult('bug'));
    let scheduled: (() => Promise<unknown>) | null = null;
    scheduleTaskCategorize(INPUT, fn => { scheduled = fn; }, deps(decide));
    expect(decide).not.toHaveBeenCalled();
    await scheduled!();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('falls back to fire-and-forget when the scheduler is unavailable', async () => {
    const decide = mock(async () => okResult('bug'));
    scheduleTaskCategorize(INPUT, () => { throw new Error('outside request scope'); }, deps(decide));
    await new Promise(r => setTimeout(r, 0));
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
