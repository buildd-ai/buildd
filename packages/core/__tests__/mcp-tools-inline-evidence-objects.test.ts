/**
 * get_task and get_pr list the stored run-evidence objects (pointers only) and
 * stay silent when there are none.
 */
import { describe, expect, it } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const ctx: ActionContext = { workerId: 'worker-1', getWorkspaceId: async () => 'workspace-1', getLevel: async () => 'worker' };
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OBJECTS = [
  { id: 'e1', kind: 'command_output', bytes: 2048, uploadState: 'stored' },
  { id: 'e2', kind: 'ci_job_log', bytes: 5 * 1048576, uploadState: 'pending' },
];

const PR = {
  ok: true,
  pr: {
    number: 7, title: 'A PR', body: null, state: 'open', url: 'https://github.com/o/r/pull/7',
    mergeable: true, mergeableState: 'clean', headSha: 's', baseRef: 'dev',
    additions: null, deletions: null, changedFiles: null, generatedAdditions: 0, generatedDeletions: 0, generatedFiles: 0,
  },
  checks: { total: 0, passed: 0, failed: 0, pending: 0, state: 'none', failedChecks: [] },
  reviews: { approved: 0, changesRequested: 0, pending: 0 },
};

const textOf = (out: unknown) => (out as { content: Array<{ text: string }> }).content[0]!.text;

describe('inline evidence objects', () => {
  it('get_task lists kind, size, state and id', async () => {
    const out = textOf(await handleBuilddAction(
      (async () => ({ id: TASK_ID, title: 'T', status: 'failed', evidenceObjects: OBJECTS })) as unknown as ApiFn,
      'get_task', { taskId: TASK_ID }, ctx,
    ));
    expect(out).toContain('Run evidence objects (2)');
    expect(out).toContain('command_output · 2 KiB (id: e1)');
    expect(out).toContain('ci_job_log · 5.0 MiB · pending (id: e2)');
    expect(out).toContain('read_evidence');
  });

  it('get_task says nothing when the task has no objects', async () => {
    const out = textOf(await handleBuilddAction(
      (async () => ({ id: TASK_ID, title: 'T', status: 'failed' })) as unknown as ApiFn,
      'get_task', { taskId: TASK_ID }, ctx,
    ));
    expect(out).not.toContain('Run evidence objects');
  });

  it('get_pr lists them and omits the section when empty', async () => {
    const run = async (extra: Record<string, unknown>) => textOf(await handleBuilddAction(
      (async () => ({ ...PR, ...extra })) as unknown as ApiFn, 'get_pr', { prNumber: 7 }, ctx,
    ));
    expect(await run({ evidenceObjects: OBJECTS })).toContain('ci_job_log · 5.0 MiB · pending (id: e2)');
    expect(await run({})).not.toContain('Run evidence objects');
  });
});
