import { describe, it, expect, mock } from 'bun:test';

/**
 * Shadow mode for the task category decision: runs beside the keyword
 * classifier, logs agreement, and must be incapable of changing a task or of
 * failing task creation. `decisionCall` is injected, so nothing here reaches the
 * DB or the network.
 */

const {
  runTaskCategoryShadow,
  scheduleTaskCategoryShadow,
  buildTaskCategoryState,
  TASK_CATEGORY_QUESTIONS,
  TASK_CATEGORY_LABELS,
  SHADOW_DESCRIPTION_CHARS,
  SHADOW_TIMEOUT_MS,
  SHADOW_LOG_PREFIX,
} = await import('./task-category-decision');

const INPUT = {
  taskId: 'task-1',
  teamId: 'team-1',
  workspaceId: 'ws-1',
  accountId: 'acct-1',
  title: 'Fix crash when saving settings',
  description: 'Saving throws a TypeError.',
  keywordCategory: 'bug' as const,
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

describe('TASK_CATEGORY_QUESTIONS', () => {
  it('offers every stored category, including review, and no catch-all', () => {
    const labels = Object.keys(TASK_CATEGORY_QUESTIONS.category.criteria).sort();
    expect(labels).toEqual([...TASK_CATEGORY_LABELS].sort());
    expect(labels).toContain('review');
    expect(labels).not.toContain('other');
  });

  it('tells the model to follow definitions over title keywords', () => {
    expect(JSON.stringify(TASK_CATEGORY_QUESTIONS.category.instructions)).toMatch(/Follow the category definitions/);
  });
});

describe('buildTaskCategoryState', () => {
  it('truncates long descriptions', () => {
    const s = buildTaskCategoryState('t', 'x'.repeat(SHADOW_DESCRIPTION_CHARS + 500));
    expect(s.task.description.length).toBe(SHADOW_DESCRIPTION_CHARS + 1);
  });

  it('handles a missing description', () => {
    expect(buildTaskCategoryState(' t ', null)).toEqual({ task: { title: 't', description: '' } });
  });
});

describe('runTaskCategoryShadow', () => {
  it('asks under the shadow capability with a short deadline and logs agreement', async () => {
    const decide = mock(async () => okResult('bug', 0.92));
    const lines: string[] = [];
    const rec = await runTaskCategoryShadow(INPUT, { decide: decide as any, log: l => lines.push(l) });

    const args = (decide.mock.calls[0] as any[])[0];
    expect(args.capability).toBe('task_category_shadow');
    expect(args.timeoutMs).toBe(SHADOW_TIMEOUT_MS);
    expect(args.teamId).toBe('team-1');
    expect(args.workspaceId).toBe('ws-1');
    expect(args.accountId).toBe('acct-1');
    expect(args.state).toEqual({ task: { title: INPUT.title, description: INPUT.description } });

    expect(rec).toMatchObject({ keyword: 'bug', decision: 'bug', confidence: 0.92, agree: true, costUsd: 0.0000126 });
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`${SHADOW_LOG_PREFIX} `)).toBe(true);
    expect(JSON.parse(lines[0].slice(SHADOW_LOG_PREFIX.length + 1)).taskId).toBe('task-1');
  });

  it('never puts task content in the log line', async () => {
    const lines: string[] = [];
    await runTaskCategoryShadow(INPUT, { decide: (async () => okResult('feature')) as any, log: l => lines.push(l) });
    expect(lines[0]).not.toContain('crash');
    expect(lines[0]).not.toContain('TypeError');
  });

  it('records disagreement, and null agreement when the keyword classifier abstained', async () => {
    const dis = await runTaskCategoryShadow(INPUT, { decide: (async () => okResult('refactor')) as any, log: () => {} });
    expect(dis?.agree).toBe(false);
    const abstain = await runTaskCategoryShadow({ ...INPUT, keywordCategory: null }, {
      decide: (async () => okResult('docs')) as any, log: () => {},
    });
    expect(abstain?.agree).toBeNull();
  });

  it('is silent when not enabled or not configured (the default)', async () => {
    for (const error of [{ kind: 'capability_disabled', capability: 'task_category_shadow' }, { kind: 'missing_key' }]) {
      const lines: string[] = [];
      const rec = await runTaskCategoryShadow(INPUT, {
        decide: (async () => ({ ok: false, error, latencyMs: 1, attempts: 0 })) as any,
        log: l => lines.push(l),
      });
      expect(rec).toBeNull();
      expect(lines).toHaveLength(0);
    }
  });

  it('logs a real failure without throwing', async () => {
    const lines: string[] = [];
    const rec = await runTaskCategoryShadow(INPUT, {
      decide: (async () => ({ ok: false, error: { kind: 'timeout', timeoutMs: 3000 }, latencyMs: 3000, attempts: 1 })) as any,
      log: l => lines.push(l),
    });
    expect(rec).toBeNull();
    expect(lines[0]).toContain('"error":"timeout"');
  });

  it('swallows a thrown error', async () => {
    const rec = await runTaskCategoryShadow(INPUT, {
      decide: (async () => { throw new Error('boom'); }) as any, log: () => {},
    });
    expect(rec).toBeNull();
  });

  it('never sends a sensitive workspace\'s task content out', async () => {
    const decide = mock(async () => okResult('bug'));
    const rec = await runTaskCategoryShadow({ ...INPUT, dataClass: 'sensitive' }, { decide: decide as any, log: () => {} });
    expect(rec).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('scheduleTaskCategoryShadow', () => {
  it('hands the run to the scheduler instead of running inline', async () => {
    const decide = mock(async () => okResult('bug'));
    let scheduled: (() => Promise<unknown>) | null = null;
    scheduleTaskCategoryShadow(INPUT, fn => { scheduled = fn; }, { decide: decide as any, log: () => {} });
    expect(decide).not.toHaveBeenCalled();
    await scheduled!();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('falls back to fire-and-forget when the scheduler is unavailable', async () => {
    const decide = mock(async () => okResult('bug'));
    scheduleTaskCategoryShadow(INPUT, () => { throw new Error('outside request scope'); }, { decide: decide as any, log: () => {} });
    await Promise.resolve();
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
