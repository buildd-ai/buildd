import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const TASK_ID = '11111111-1111-1111-1111-111111111111';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('get_task', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('throws when taskId is missing', async () => {
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', {}, ctx()),
    ).rejects.toThrow('taskId is required');
  });

  it('throws helpful error when taskId is an 8-character UI prefix', async () => {
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: 'b833be4b' }, ctx()),
    ).rejects.toThrow(/taskId must be a full UUID.*prefix/);
  });

  it('throws helpful error when taskId is a non-UUID string', async () => {
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: 'not-a-uuid-at-all' }, ctx()),
    ).rejects.toThrow(/taskId must be a full UUID/);
  });

  it('requests the task with include=workers,artifacts by default', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Fix bug',
      status: 'completed',
      priority: 5,
      workspace: { name: 'buildd', repo: 'buildd-ai/buildd' },
      workers: [],
      artifacts: [],
    });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    const [endpoint] = mockApi.mock.calls[0];
    const url = new URL(endpoint, 'http://localhost');
    expect(url.pathname).toBe(`/api/tasks/${TASK_ID}`);
    expect(url.searchParams.get('include')).toBe('workers,artifacts');
  });

  it('honors explicit include array', async () => {
    mockApi.mockResolvedValue({ id: TASK_ID, title: 't', status: 'pending' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID, include: ['workers'] },
      ctx(),
    );

    const [endpoint] = mockApi.mock.calls[0];
    const url = new URL(endpoint, 'http://localhost');
    expect(url.searchParams.get('include')).toBe('workers');
  });

  it('formats result with summary, PR, workers, and artifacts', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Add feature X',
      status: 'completed',
      category: 'feature',
      priority: 7,
      description: 'short desc',
      workspace: { name: 'buildd', repo: 'buildd-ai/buildd' },
      mission: { id: 'm1', title: 'Q2 platform', status: 'active' },
      result: {
        summary: 'Shipped feature X behind flag',
        prUrl: 'https://github.com/buildd-ai/buildd/pull/999',
        prNumber: 999,
        branch: 'feat/x',
        sha: 'abcdef1234567890',
        commits: 3,
        files: 4,
        added: 120,
        removed: 5,
      },
      workers: [
        {
          id: 'w-2',
          status: 'completed',
          branch: 'feat/x',
          prUrl: 'https://github.com/buildd-ai/buildd/pull/999',
          prNumber: 999,
          completedAt: '2026-05-24T12:00:00Z',
          lastCommitSha: 'abcdef1234567890',
        },
        {
          id: 'w-1',
          status: 'failed',
          branch: 'feat/x-attempt-1',
          error: 'test failed',
        },
      ],
      artifacts: [
        { id: 'a-1', title: 'Summary', type: 'summary', shareUrl: 'https://buildd.dev/share/abc' },
      ],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).toContain('Add feature X');
    expect(text).toContain('completed');
    expect(text).toContain('[feature]');
    expect(text).toContain('Q2 platform');
    expect(text).toContain('Shipped feature X behind flag');
    expect(text).toContain('pull/999');
    expect(text).toContain('abcdef1'); // short sha
    expect(text).toContain('3 commits');
    expect(text).toContain('Workers (2)');
    expect(text).toContain('w-2');
    expect(text).toContain('w-1');
    expect(text).toContain('test failed');
    expect(text).toContain('Artifacts (1)');
    expect(text).toContain('https://buildd.dev/share/abc');
  });

  it('marks a shortened description and explains how to retrieve all instructions', async () => {
    const description = 'x'.repeat(400) + '\n## Doctrine\nReview all policy sections.';
    mockApi.mockResolvedValue({ id: TASK_ID, title: 'Review', status: 'assigned', description });

    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: TASK_ID }, ctx());
    const text = result.content[0].text;
    expect(text).toContain('x'.repeat(400) + `\n\n…[truncated ${description.length - 400} chars]`);
    expect(text).toContain('fullDescription:true');
    expect(text).not.toContain('## Doctrine');
  });

  it('returns the complete description when fullDescription is true', async () => {
    const description = 'x'.repeat(400) + '\n## Doctrine\n## Workspace Policy\n## Escalation Rules\n## Proposed Policy Additions\nFinal instruction.';
    mockApi.mockResolvedValue({ id: TASK_ID, title: 'Review', status: 'assigned', description });

    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: TASK_ID, fullDescription: true }, ctx());
    expect(result.content[0].text).toContain(description);
    expect(result.content[0].text).not.toContain('[truncated');
  });

  it.each([0, 399, 400])('preserves descriptions of %i chars without a truncation warning', async (length) => {
    const description = 'x'.repeat(length);
    mockApi.mockResolvedValue({ id: TASK_ID, title: 'Review', status: 'assigned', description });

    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: TASK_ID }, ctx());
    expect(result.content[0].text).not.toContain('[truncated');
    expect(result.content[0].text).not.toContain('fullDescription:true');
    if (length) expect(result.content[0].text).toContain(description);
    else expect(result.content[0].text).not.toContain('## Description');
  });

  it('handles task with no workers or artifacts', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Pending task',
      status: 'pending',
      priority: 3,
      workspace: { name: 'buildd' },
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).toContain('Pending task');
    expect(text).toContain('pending');
    expect(text).not.toContain('Workers (');
    expect(text).not.toContain('Artifacts (');
  });

  it('returns loop configuration, state, attempt, and history', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Looping task',
      status: 'pending',
      priority: 3,
      loopConfig: {
        exitCondition: { type: 'command', command: 'bun test' },
        maxLoops: 4,
        backoffMinutes: 1,
      },
      loopIteration: 1,
      loopState: 'condition_unmet',
      context: {
        loopHistory: [{
          iteration: 0,
          workerId: 'worker-1',
          evaluatedAt: '2026-07-25T10:00:00.000Z',
          conditionType: 'command',
          satisfied: false,
          summary: 'Command exited with code 1',
          evidence: { durationMs: 1250, output: '1 test failed' },
        }],
      },
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID, include: [] },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).toContain('Loop:** condition_unmet — attempt 2/4');
    expect(text).toContain('command: `bun test`');
    expect(text).toContain('Iteration 1');
    expect(text).toContain('Command exited with code 1');
    expect(text).toContain('1 test failed');
    expect(text).toContain('1.25s');
  });

  it('includes taskUrl in output when appBaseUrl is set', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Test task',
      status: 'pending',
      priority: 5,
      workspace: { name: 'buildd' },
      workers: [],
      artifacts: [],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx({ appBaseUrl: 'https://buildd.dev' }),
    );

    const text = result.content[0].text;
    expect(text).toContain(`https://buildd.dev/app/tasks/${TASK_ID}`);
  });

  it('uses default appBaseUrl when none is set', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Test task',
      status: 'pending',
      priority: 5,
      workspace: { name: 'buildd' },
      workers: [],
      artifacts: [],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).toContain(`https://buildd.dev/app/tasks/${TASK_ID}`);
  });

  it('includes actionUrl when worker has waitingFor set', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Blocked task',
      status: 'assigned',
      priority: 5,
      workspace: { name: 'buildd' },
      workers: [
        {
          id: 'w-blocked',
          status: 'waiting_input',
          branch: 'feat/x',
          waitingFor: { type: 'question', prompt: 'Which approach?', options: ['A', 'B'] },
        },
      ],
      artifacts: [],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx({ appBaseUrl: 'https://buildd.dev' }),
    );

    const text = result.content[0].text;
    expect(text).toContain(`https://buildd.dev/app/tasks/${TASK_ID}/respond`);
    expect(text).toContain('Which approach?');
  });

  it('surfaces a rejected deliverable payload as REJECTED, not a satisfied outcome', async () => {
    // Regression for the 54-turn-run-lost incident: outputRequirement
    // 'artifact_required' refused complete_task and persisted the agent's
    // summary onto workers.rejectedCompletionPayload, but get_task never
    // read it back — the operator saw only the raw 400 in worker.error.
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Recon task',
      status: 'failed',
      priority: 5,
      workspace: { name: 'buildd' },
      workers: [
        {
          id: 'w-failed',
          status: 'failed',
          branch: 'buildd/recon',
          error: 'API error: 400 - {"error":"This task requires a deliverable before completing."}',
          rejectedCompletionPayload: {
            reason: 'artifact_required',
            summary: '54 turns of findings on the design-canvas question.',
            summarySource: 'fallback',
            rejectedAt: '2026-09-20T12:41:21.137Z',
            salvagedArtifactId: 'art-salvage-1',
          },
        },
      ],
      artifacts: [],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).toContain('Rejected deliverable');
    expect(text).toContain("not satisfied, not a completed outcome");
    expect(text).toContain('54 turns of findings');
    expect(text).toContain('art-salvage-1');
  });

  it('includes workerUrl for each worker', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Running task',
      status: 'assigned',
      priority: 5,
      workspace: { name: 'buildd' },
      workers: [
        {
          id: 'w-running',
          status: 'running',
          branch: 'feat/x',
        },
      ],
      artifacts: [],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: TASK_ID },
      ctx({ appBaseUrl: 'https://buildd.dev' }),
    );

    const text = result.content[0].text;
    expect(text).toContain(`https://buildd.dev/app/tasks/${TASK_ID}`);
  });

  it('surfaces a running worker\'s currentAction', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Running task',
      status: 'assigned',
      priority: 5,
      workspace: { name: 'buildd' },
      workers: [
        { id: 'w-running', status: 'running', branch: 'feat/x', currentAction: 'Running tests' },
      ],
      artifacts: [],
    });

    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: TASK_ID }, ctx());

    expect(result.content[0].text).toContain('Current action: Running tests');
  });

  it('hints that a pending task has not been claimed when there are no workers or result', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Pending task',
      status: 'pending',
      priority: 3,
      workspace: { name: 'buildd' },
      workers: [],
      artifacts: [],
    });

    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: TASK_ID }, ctx());

    expect(result.content[0].text).toContain('Task is pending — not yet claimed by a worker.');
  });

  it('hints that a completed task has no result snapshot when there are no workers or result', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'Old completed task',
      status: 'completed',
      priority: 3,
      workspace: { name: 'buildd' },
      workers: [],
      artifacts: [],
    });

    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: TASK_ID }, ctx());

    expect(result.content[0].text).toContain('Task completed but no result snapshot available.');
  });

  it('omits the hint once a worker or result exists', async () => {
    mockApi.mockResolvedValue({
      id: TASK_ID,
      title: 'In progress',
      status: 'assigned',
      priority: 3,
      workspace: { name: 'buildd' },
      workers: [{ id: 'w-1', status: 'running', branch: 'feat/x' }],
      artifacts: [],
    });

    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: TASK_ID }, ctx());

    expect(result.content[0].text).not.toContain('not yet claimed by a worker');
    expect(result.content[0].text).not.toContain('no result snapshot available');
  });
});

describe('get_task — evidence', () => {
  const evidence = {
    errorClass: 'test_failure',
    keyLines: ['(fail) billing > rounds up', 'error: expected 2 received 3'],
    lastFailingCommand: { command: 'bun run test', exitCode: 1 },
    ciChecks: [{ name: 'unit', state: 'failed', url: 'https://ci.example/job/1' }],
    diff: { files: 0, added: 0, removed: 0 },
    links: { prUrl: 'https://example.invalid/pr/7' },
    keyLinesSource: 'traces',
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
  const base = { id: TASK_ID, title: 'Fix rounding', priority: 3, workspace: { name: 'buildd' }, workers: [], artifacts: [] };

  it('answers "why did it fail" inline: class, command, failing check and key lines', async () => {
    const mockApi = mock().mockResolvedValue({ ...base, status: 'failed', result: { error: 'boom', evidence } });
    const text = (await handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: TASK_ID }, ctx())).content[0].text;
    expect(text).toContain('## Evidence');
    expect(text).toContain('**Error class:** test_failure');
    expect(text).toContain('`bun run test` (exit 1)');
    expect(text).toContain('✗ unit — https://ci.example/job/1');
    expect(text).toContain('(fail) billing > rounds up');
  });

  it('shows mismatch flags before the evidence', async () => {
    const mockApi = mock().mockResolvedValue({
      ...base, status: 'completed',
      result: { summary: 'Pushed the fix', evidence, mismatch: [{ kind: 'pushed_without_diff', detail: 'diff is 0 files' }] },
    });
    const text = (await handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: TASK_ID }, ctx())).content[0].text;
    expect(text).toContain('## ⚠️ Mismatch');
    expect(text).toContain('diff is 0 files');
    expect(text.indexOf('## ⚠️ Mismatch')).toBeLessThan(text.indexOf('## Evidence'));
  });

  it('prints nothing extra for a clean run', async () => {
    const mockApi = mock().mockResolvedValue({ ...base, status: 'completed', result: { summary: 'Done' } });
    const text = (await handleBuilddAction(mockApi as unknown as ApiFn, 'get_task', { taskId: TASK_ID }, ctx())).content[0].text;
    expect(text).not.toContain('## Evidence');
    expect(text).not.toContain('Mismatch');
  });
});

describe('get_error_traces — evidence', () => {
  it('returns the task\'s evidence with its traces', async () => {
    const mockApi = mock().mockResolvedValue({
      traces: [{ pattern: 'bash_nonzero_exit', excerpt: '$ bun run test [exit 1]\n(fail) x', source: 'Bash', ts: 't' }],
      evidence: { errorClass: 'type_error', keyLines: ['a.ts(1,1): error TS2322'], diff: { files: 1, added: 1, removed: 0 }, links: {}, keyLinesSource: 'traces', capturedAt: 'x' },
      mismatch: [],
    });
    const text = (await handleBuilddAction(mockApi as unknown as ApiFn, 'get_error_traces', { taskId: TASK_ID }, ctx())).content[0].text;
    expect(text).toContain('bash_nonzero_exit');
    expect(text).toContain('**Error class:** type_error');
    expect(text).toContain('error TS2322');
  });

  it('still returns evidence when no trace was captured', async () => {
    const mockApi = mock().mockResolvedValue({
      traces: [],
      evidence: { errorClass: 'test_failure', keyLines: ['(fail) from digest'], diff: { files: 0, added: 0, removed: 0 }, links: {}, keyLinesSource: 'ci_digest', capturedAt: 'x' },
    });
    const text = (await handleBuilddAction(mockApi as unknown as ApiFn, 'get_error_traces', { taskId: TASK_ID }, ctx())).content[0].text;
    expect(text).toContain('No error traces');
    expect(text).toContain('(fail) from digest');
  });
});

describe('get_task — include validation and scheduling view', () => {
  const api = (task: Record<string, unknown>) => mock(async () => ({ id: TASK_ID, title: 'Build step', status: 'pending', ...task })) as unknown as ApiFn;

  it('rejects an unsupported include value instead of silently ignoring it', async () => {
    const a = api({});
    await expect(handleBuilddAction(a, 'get_task', { taskId: TASK_ID, include: ['workers', 'sheduling'] }, ctx()))
      .rejects.toThrow(/unsupported: sheduling/);
    expect(a).not.toHaveBeenCalled();
  });

  it('omits the scheduling section by default', async () => {
    const out = await handleBuilddAction(api({ dependsOn: ['x'], tier: 'premium' }), 'get_task', { taskId: TASK_ID }, ctx());
    expect(out.content[0].text).not.toContain('## Scheduling');
  });

  it('renders dependsOn, manifests, tier, verification command and spec source on request, without asking the server for it', async () => {
    const a = api({
      dependsOn: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
      pathManifest: ['apps/web/src/a.ts', 'packages/core/b.ts'],
      pathDeclaration: {
        declared: ['apps/web/src/a.ts', 'packages/core/b.ts', 'docs/c.md'],
        source: 'creation',
        snapshotAt: '2026-10-01T00:00:00.000Z',
        inferredDependsOn: ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
        narrowings: [{ at: 'x', dropped: ['docs/c.md'], surface: 's', reason: null }],
      },
      pathClaimRevision: 2,
      tier: 'premium',
      complexity: 'normal',
      kind: 'engineering',
      context: { verificationCommand: 'bun run test', specSource: { specPath: 'docs/specs/x.md', planningTaskId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' } },
    });
    const out = await handleBuilddAction(a, 'get_task', { taskId: TASK_ID, include: ['scheduling'] }, ctx());
    const text = out.content[0].text;
    expect(text).toContain('## Scheduling');
    expect(text).toContain('**Depends on (2):** aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa, bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(text).toContain('**Path manifest (2):** apps/web/src/a.ts, packages/core/b.ts');
    expect(text).toContain('**Declared manifest (creation):** apps/web/src/a.ts, packages/core/b.ts, docs/c.md');
    expect(text).toContain('**Inferred dependsOn:** bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(text).toContain('**Narrowings:** 1');
    expect(text).toContain('**Tier:** premium');
    expect(text).toContain('**Verification command:** `bun run test`');
    expect(text).toContain('**Spec source:** docs/specs/x.md (planning task cccccccc-cccc-cccc-cccc-cccccccccccc)');
    // Scheduling is rendered from the task row; the server only adds the frozen estimate.
    expect((a as any).mock.calls[0][0]).toBe(`/api/tasks/${TASK_ID}?include=estimate`);
    // No estimate on the row: nothing about one is said.
    expect(text).not.toContain('Estimate');
  });

  it('renders the frozen estimate (task-estimates experiment) in the scheduling block', async () => {
    const a = api({
      estimate: {
        estimatorVersion: 'blend-v1', p50Minutes: 41.6, p80Minutes: 70.2, p50Tokens: 120_400, p80Tokens: 219_600,
        expectedRepairs: 0.4, summary: '40m (25-70m), 120k tokens, from 6 similar tasks, plus typical engineering tasks.',
      },
    });
    const out = await handleBuilddAction(a, 'get_task', { taskId: TASK_ID, include: ['workers', 'scheduling'] }, ctx());
    expect((a as any).mock.calls[0][0]).toBe(`/api/tasks/${TASK_ID}?include=${encodeURIComponent('workers,estimate')}`);
    expect(out.content[0].text).toContain(
      '**Estimate (blend-v1):** 42-70m · 120k-220k tokens · 40m (25-70m), 120k tokens, from 6 similar tasks, plus typical engineering tasks.',
    );
  });

  it('the estimate is never asked for or shown without include scheduling', async () => {
    const a = api({ estimate: { estimatorVersion: 'blend-v1', p50Minutes: 40, p80Minutes: 70, p50Tokens: 1, p80Tokens: 2, summary: 's' } });
    const out = await handleBuilddAction(a, 'get_task', { taskId: TASK_ID, include: ['workers'] }, ctx());
    expect((a as any).mock.calls[0][0]).toBe(`/api/tasks/${TASK_ID}?include=workers`);
    expect(out.content[0].text).not.toContain('Estimate');
  });

  it('states absent scheduling facts explicitly rather than omitting them', async () => {
    const out = await handleBuilddAction(api({ dependsOn: [], pathManifest: null, tier: null }), 'get_task', { taskId: TASK_ID, include: ['workers', 'scheduling'] }, ctx());
    const text = out.content[0].text;
    expect(text).toContain('**Depends on:** none');
    expect(text).toContain('**Path manifest:** none declared');
    expect(text).toContain('**Tier:** unset');
  });
});

describe('get_task backend line', () => {
  const read = async (task: Record<string, unknown>) => {
    const a = mock(async () => ({ id: TASK_ID, title: 't', status: 'in_progress', ...task }));
    const out = await handleBuilddAction(a as unknown as ApiFn, 'get_task', { taskId: TASK_ID, include: ['workers'] }, ctx());
    return out.content[0].text as string;
  };

  it('says why the backend changed when a claim flipped it', async () => {
    const text = await read({
      backend: 'claude',
      context: { backendRouting: { backend: 'codex', from: 'claude', reason: 'claude_seat_exhausted' } },
    });
    expect(text).toContain('**Backend:** Codex (routed to Codex by budget failover (Claude seat exhausted))');
  });

  it('marks a pinned backend', async () => {
    const text = await read({ backend: 'claude', context: { backendPinned: true } });
    expect(text).toContain('**Backend:** Claude (pinned: failover will not move it)');
  });

  it('prints nothing about the backend when it is the unpinned default', async () => {
    const text = await read({ backend: 'claude', context: {} });
    expect(text).not.toContain('**Backend:**');
  });
});
