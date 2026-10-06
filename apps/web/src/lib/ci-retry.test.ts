import { describe, it, expect } from 'bun:test';
import { buildCIRetryTask, summarizePrFixAttempts } from './ci-retry';

const baseParams = {
  originalTask: {
    id: 't1',
    title: 'Fix the parser',
    description: 'orig',
    workspaceId: 'ws1',
    context: {} as Record<string, unknown>,
    missionId: 'm1',
  },
  worker: { id: 'w1', branch: 'buildd/abc-fix', prNumber: 42 },
  failureContext: 'Job "test" failed',
  repoFullName: 'org/repo',
};

describe('buildCIRetryTask', () => {
  it('builds the first retry (iteration 0 → 1) with branch + mission continuity', () => {
    const t = buildCIRetryTask(baseParams);
    expect(t).not.toBeNull();
    expect(t!.title).toBe('[builder · after CI #1] Fix the parser');
    expect(t!.parentTaskId).toBe('t1');
    expect(t!.missionId).toBe('m1');
    expect(t!.creationSource).toBe('webhook');
    expect(t!.context.iteration).toBe(1);
    expect(t!.context.maxIterations).toBe(3);
    expect(t!.context.baseBranch).toBe('buildd/abc-fix');
    expect(t!.context.prNumber).toBe(42);
    // failureContext is now a structured object, not a bare string
    expect((t!.context.failureContext as any).summary).toBe('Job "test" failed');
  });

  it('stamps the chain root and PR number, and carries them through a second retry', () => {
    const first = buildCIRetryTask(baseParams);
    expect(first!.context.rootTaskId).toBe('t1');
    expect(first!.context.lineagePrNumbers).toEqual([42]);
    const second = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, id: 't2', title: first!.title, context: first!.context },
      worker: { id: 'w2', branch: 'buildd/new-branch', prNumber: 57 },
    });
    expect(second!.context.rootTaskId).toBe('t1');
    expect(second!.context.lineagePrNumbers).toEqual([42, 57]);
  });

  it('does not double-prefix the title on subsequent retries', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, title: '[builder · after CI #1] Fix the parser', context: { iteration: 1 } },
    });
    expect(t!.title).toBe('[builder · after CI #2] Fix the parser');
    expect(t!.context.iteration).toBe(2);
  });

  it('returns null when retries are exhausted (iteration >= max)', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { iteration: 3 } },
    });
    expect(t).toBeNull();
  });

  it('returns null when maxCiRetries is 0 (disabled)', () => {
    const t = buildCIRetryTask({ ...baseParams, workspaceMaxCiRetries: 0 });
    expect(t).toBeNull();
  });

  it('workspace maxCiRetries overrides task-level maxIterations', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { iteration: 1, maxIterations: 2 } },
      workspaceMaxCiRetries: 5,
    });
    expect(t!.context.maxIterations).toBe(5);
    expect(t!.context.iteration).toBe(2);
  });

  it('embeds a command that actually returns log output', () => {
    // `gh run view <id> --log-failed` returns EMPTY output and exit 0 — verified
    // repeatedly against this repo's own failed runs. It was the retry task's
    // only instruction for reading the failure, so a cold-start agent followed
    // it, got nothing, and re-derived the failure by hand. The jobs-logs API is
    // the form that works.
    const t = buildCIRetryTask({
      ...baseParams,
      ciRunId: 12345,
      ciRunUrl: 'https://github.com/org/repo/actions/runs/12345',
      ciFailedJobId: 67890,
    });
    expect(t!.description).not.toContain('--log-failed');
    expect(t!.description).toContain('/repos/org/repo/actions/jobs/67890/logs');
    expect(t!.context.ciRunId).toBe(12345);
  });

  it('falls back to naming the run when no failed job id was resolved', () => {
    const t = buildCIRetryTask({ ...baseParams, ciRunId: 12345, ciRunUrl: 'https://github.com/org/repo/actions/runs/12345' });
    expect(t!.description).not.toContain('--log-failed');
    // Without a job id the agent still needs the two-step: list the jobs, then
    // read the failing one's log.
    expect(t!.description).toContain('/actions/runs/12345/jobs');
  });

  it('omits the gh log section when no run id is available', () => {
    const t = buildCIRetryTask(baseParams);
    expect(t!.description).not.toContain('gh run view');
    expect(t!.context.ciRunId).toBeUndefined();
  });

  it('preserves verificationCommand and skillSlugs from the original task', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { verificationCommand: 'bun test', skillSlugs: ['x'] } },
    });
    expect(t!.context.verificationCommand).toBe('bun test');
    expect(t!.context.skillSlugs).toEqual(['x']);
  });

  // Spec §6.3 — retry-continuity fields
  it('sets context.resumeBranch equal to worker.branch', () => {
    const t = buildCIRetryTask(baseParams);
    expect(t!.context.resumeBranch).toBe('buildd/abc-fix');
  });

  it('still sets context.baseBranch for backward compat', () => {
    const t = buildCIRetryTask(baseParams);
    expect(t!.context.baseBranch).toBe('buildd/abc-fix');
  });

  it('sets context.failureContext as a RetryFailureContext object with errorType ci_failure', () => {
    const t = buildCIRetryTask(baseParams);
    expect(typeof t!.context.failureContext).toBe('object');
    const fc = t!.context.failureContext as any;
    expect(fc.summary).toBe('Job "test" failed');
    expect(fc.errorType).toBe('ci_failure');
  });

  it('copies context.lastCommitSha from parent task context when present', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { lastCommitSha: 'abc123sha' } },
    });
    expect(t!.context.lastCommitSha).toBe('abc123sha');
  });

  it('includes commitSha in failureContext when parent context has lastCommitSha', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { lastCommitSha: 'abc123sha' } },
    });
    const fc = t!.context.failureContext as any;
    expect(fc.commitSha).toBe('abc123sha');
  });

  it('omits lastCommitSha from context when parent context lacks it', () => {
    const t = buildCIRetryTask(baseParams);
    expect(t!.context.lastCommitSha).toBeUndefined();
  });

  // ── Foreign-commit / non-worker-authored SHA ─────────────────────────────

  it('foreign commit: creates retry task without incrementing iteration', () => {
    const t = buildCIRetryTask({ ...baseParams, foreignHeadSha: true, foreignCommitAuthor: 'maxjacu' });
    expect(t).not.toBeNull();
    // iteration must NOT advance — the agent's budget is preserved
    expect(t!.context.iteration).toBe(0);
    expect(t!.context.foreign_head_sha).toBe(true);
    expect(t!.context.foreignCommitAuthor).toBe('maxjacu');
  });

  it('foreign commit: display title still uses currentIteration + 1 for readability', () => {
    const t = buildCIRetryTask({ ...baseParams, foreignHeadSha: true });
    expect(t!.title).toBe('[builder · after CI #1] Fix the parser');
  });

  it('foreign commit: description notes the non-worker push and budget preservation', () => {
    const t = buildCIRetryTask({ ...baseParams, foreignHeadSha: true, foreignCommitAuthor: 'maxjacu' });
    expect(t!.description).toContain('not consumed');
    expect(t!.description).toContain('@maxjacu');
  });

  it('three consecutive foreign pushes do not exhaust the retry budget', () => {
    // Each foreign push keeps iteration at its current value; agent always retains full quota.
    let ctx: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) {
      const t = buildCIRetryTask({
        ...baseParams,
        originalTask: { ...baseParams.originalTask, context: ctx },
        foreignHeadSha: true,
        foreignCommitAuthor: 'maxjacu',
      });
      expect(t).not.toBeNull();
      // iteration must stay at 0 after every foreign push
      expect(t!.context.iteration).toBe(0);
      ctx = t!.context; // carry forward for next iteration
    }
  });

  it('mixed chain (worker, outsider, worker): exactly 2 agent attempts counted', () => {
    // Attempt 1: worker fails → iteration 0 → 1
    const t1 = buildCIRetryTask({ ...baseParams, foreignHeadSha: false });
    expect(t1!.context.iteration).toBe(1);

    // Outsider push at iteration 1 → iteration stays 1
    const t2 = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: t1!.context },
      foreignHeadSha: true,
    });
    expect(t2!.context.iteration).toBe(1);

    // Attempt 2: worker fails → iteration 1 → 2
    const t3 = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: t2!.context },
      foreignHeadSha: false,
    });
    expect(t3!.context.iteration).toBe(2);
  });

  it('foreign commit at max iterations: still creates a retry task (budget not consumed)', () => {
    // Iteration is already at max due to genuine agent failures, but this SHA is foreign.
    // Foreign commits bypass the exhaustion cap — the PR needs to get fixed regardless.
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { iteration: 3 } },
      workspaceMaxCiRetries: 3,
      foreignHeadSha: true,
    });
    expect(t).not.toBeNull();
    expect(t!.context.iteration).toBe(3); // still 3, not 4
    expect(t!.context.foreign_head_sha).toBe(true);
  });

  it('foreign commit when retries disabled (maxCiRetries=0): returns null — retries off globally', () => {
    const t = buildCIRetryTask({ ...baseParams, workspaceMaxCiRetries: 0, foreignHeadSha: true });
    expect(t).toBeNull();
  });

  it('foreign commit with no author: omits foreignCommitAuthor from context', () => {
    const t = buildCIRetryTask({ ...baseParams, foreignHeadSha: true });
    expect(t!.context.foreign_head_sha).toBe(true);
    expect(t!.context.foreignCommitAuthor).toBeUndefined();
  });
});

describe('final-attempt handoff request', () => {
  function params(overrides: Record<string, unknown> = {}) {
    return {
      originalTask: {
        id: 'task-1',
        title: 'Health tab restructure',
        description: 'Restructure the health tab.',
        workspaceId: 'ws-1',
        context: { iteration: 2, maxIterations: 3 },
        missionId: 'mis-1',
      },
      worker: { id: 'w-1', branch: 'feat/health', prNumber: 2054 },
      failureContext: 'bun test failed: 3 files',
      repoFullName: 'org/repo',
      ...overrides,
    } as Parameters<typeof buildCIRetryTask>[0];
  }

  it('asks the final attempt to hand off a recommendation if it cannot fix CI', () => {
    const task = buildCIRetryTask(params());
    expect(task).not.toBeNull();
    expect(task!.title).toContain('#3');
    expect(task!.description).toContain('final attempt');
    expect(task!.description).toContain('nextSuggestion');
  });

  it('does not ask for a handoff on a non-final attempt', () => {
    const task = buildCIRetryTask(params({
      originalTask: { ...params().originalTask, context: { iteration: 0, maxIterations: 3 } },
    }));
    expect(task!.description).not.toContain('nextSuggestion');
  });

  it('asks for a handoff when the workspace allows only one attempt', () => {
    const task = buildCIRetryTask(params({
      originalTask: { ...params().originalTask, context: { iteration: 0 } },
      workspaceMaxCiRetries: 1,
    }));
    expect(task!.description).toContain('nextSuggestion');
  });
});

describe('green means the PR\'s checks, not the local run', () => {
  // A local single-file type check passed while the PR's gating checks stayed
  // red, and the attempt reported SUCCESS anyway.
  const make = (iteration: number) => buildCIRetryTask({
    originalTask: {
      id: 'task-1', title: 'Some work', description: 'd', workspaceId: 'ws-1',
      context: { iteration, maxIterations: 3 }, missionId: 'mis-1',
    },
    worker: { id: 'w-1', branch: 'feat/x', prNumber: 3206 },
    failureContext: 'tsc failed',
    repoFullName: 'org/repo',
  } as Parameters<typeof buildCIRetryTask>[0])!;

  for (const iteration of [0, 1, 2]) {
    it(`attempt ${iteration + 1}: says to confirm gh pr checks is green on the PR before reporting success`, () => {
      const d = make(iteration).description;
      expect(d).toContain('gh pr checks 3206');
      expect(d).toMatch(/SUCCESS/);
      expect(d).toMatch(/still (red|failing)/i);
    });
  }

  it('does not let a passing local check stand in for the PR\'s checks', () => {
    expect(make(0).description).toMatch(/local run[\s\S]*is not enough/i);
  });
});

describe('summarizePrFixAttempts', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'r', status: 'completed', creationSource: 'webhook', outputRequirement: null,
    ciRetryPrNumber: 42, context: {}, createdAt: '2026-01-01T00:00:00Z', ...over,
  });

  it('reports a pending or running fix attempt as in flight', () => {
    expect(summarizePrFixAttempts([row({ id: 'a', status: 'pending' })], 42).inFlight?.id).toBe('a');
    expect(summarizePrFixAttempts([row({ id: 'b', status: 'in_progress', ciRetryPrNumber: null })], 42).inFlight?.id).toBe('b');
    expect(summarizePrFixAttempts([row({ status: 'completed' }), row({ status: 'failed' })], 42).inFlight).toBeNull();
  });

  it('counts only agent-authored automatic CI retries', () => {
    const { ciRetriesUsed } = summarizePrFixAttempts([
      row({ id: '1' }),
      row({ id: '2', status: 'failed' }),
      row({ id: 'foreign', context: { foreign_head_sha: true } }),
      row({ id: 'drift', outputRequirement: 'artifact_required' }),
      row({ id: 'review-fix', ciRetryPrNumber: null }),
      row({ id: 'other-pr', ciRetryPrNumber: 7 }),
    ], 42);
    expect(ciRetriesUsed).toBe(2);
  });

  it('does not spend the budget on an attempt the CLI rejected for its model id', () => {
    const { ciRetriesUsed } = summarizePrFixAttempts([
      row({ id: 'real', status: 'failed' }),
      row({ id: 'rejected', status: 'failed', context: { modelRejection: { model: 'claude-sonnet-5-5' } } }),
    ], 42);
    expect(ciRetriesUsed).toBe(1);
  });

  it('a manual Fix CI click starts a fresh budget', () => {
    const { ciRetriesUsed } = summarizePrFixAttempts([
      row({ id: '1', createdAt: '2026-01-01T00:00:00Z' }),
      row({ id: '2', createdAt: '2026-01-01T01:00:00Z' }),
      row({ id: 'manual', creationSource: 'dashboard', createdAt: '2026-01-01T02:00:00Z' }),
      row({ id: '3', createdAt: '2026-01-01T03:00:00Z' }),
    ], 42);
    expect(ciRetriesUsed).toBe(1);
  });
});

describe('bound PR lineage', () => {
  it('names the PR head as push target and forbids a new create_pr when head differs from the worker branch', () => {
    const t = buildCIRetryTask({ ...baseParams, prRefs: { headRef: 'mission/m-1', baseRef: 'dev' } });
    const d = t!.description;
    expect(d).toContain('Bound PR lineage');
    expect(d).toContain('`mission/m-1`');
    expect(d).toContain('Do NOT open a new task-branch PR');
    expect(d).toContain('5. Push your fixes to `mission/m-1`');
  });

  it('adds nothing when the PR head is the worker branch or refs are unknown', () => {
    for (const prRefs of [{ headRef: 'buildd/abc-fix', baseRef: 'dev' }, null, undefined]) {
      const d = buildCIRetryTask({ ...baseParams, prRefs })!.description;
      expect(d).not.toContain('Bound PR lineage');
      expect(d).toContain('Push your fixes to the existing branch');
    }
  });
});
