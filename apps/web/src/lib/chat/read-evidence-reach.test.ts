/**
 * AC-5 (docs/specs/byo-evidence-storage.md), chat half: `read_evidence` run
 * from chat, through the real registry routes, the real reach guard and the
 * real evidence route handlers. Only the db, the session and the bucket are
 * stubbed.
 *
 * - An in-reach `{prNumber, kind: 'ci_job_log', grep}` returns only the
 *   matching lines.
 * - A task or PR outside the conversation's reach (a sensitive workspace the
 *   user can open in the dashboard, or another team's) is refused, and the
 *   bucket is never read.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { gzipSync } from 'zlib';

const WS_OK = '11111111-1111-4111-8111-111111111111';
const WS_SENSITIVE = '22222222-2222-4222-8222-222222222222';
const WS_OTHER_TEAM = '33333333-3333-4333-8333-333333333333';
const TASK_OK = 'aaaaaaaa-0000-4000-8000-000000000001';
const TASK_SENSITIVE = 'aaaaaaaa-0000-4000-8000-000000000002';
const TASK_OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const EV_OK = 'eeeeeeee-0000-4000-8000-000000000001';
const EV_SENSITIVE = 'eeeeeeee-0000-4000-8000-000000000002';
const EV_OTHER = 'eeeeeeee-0000-4000-8000-000000000003';
const BACKEND = 'bbbbbbbb-0000-4000-8000-000000000001';

const TASKS: Record<string, { id: string; workspaceId: string; teamId: string }> = {
  [TASK_OK]: { id: TASK_OK, workspaceId: WS_OK, teamId: 't-1' },
  [TASK_SENSITIVE]: { id: TASK_SENSITIVE, workspaceId: WS_SENSITIVE, teamId: 't-1' },
  [TASK_OTHER]: { id: TASK_OTHER, workspaceId: WS_OTHER_TEAM, teamId: 't-2' },
};
const obj = (id: string, taskId: string, workspaceId: string, prNumber: number) => ({
  id, workspaceId, taskId, rootTaskId: taskId, workerId: 'w-1', prNumber, kind: 'ci_job_log',
  backendId: BACKEND, objectKey: `evidence/${id}.log.gz`, bytes: 100, sha256: null,
  uploadState: 'stored', indexState: 'skipped', expiresAt: null,
  createdAt: new Date('2026-09-30T00:00:00Z'), updatedAt: new Date('2026-09-30T00:00:00Z'),
});
const OBJECTS = [obj(EV_OK, TASK_OK, WS_OK, 7), obj(EV_SENSITIVE, TASK_SENSITIVE, WS_SENSITIVE, 8), obj(EV_OTHER, TASK_OTHER, WS_OTHER_TEAM, 9)];
const WORKERS = [
  { taskId: TASK_OK, workspaceId: WS_OK, prNumber: 7 },
  { taskId: TASK_SENSITIVE, workspaceId: WS_SENSITIVE, prNumber: 8 },
  { taskId: TASK_OTHER, workspaceId: WS_OTHER_TEAM, prNumber: 9 },
];

const dialect = new PgDialect();
const paramsOf = (where: any): unknown[] => dialect.sqlToQuery(where).params;

// The user can open every one of these workspaces in the dashboard; only the
// chat reach narrows it. That is the case the guard exists for.
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'user-1' }) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async () => ({ teamId: 't-1', role: 'member' }),
  verifyAccountWorkspaceAccess: async () => true,
}));

const bucketReads: string[] = [];
const LOG = ['step 1 ok', 'Run tests', 'FAIL src/a.test.ts', '  expected 1 got 2', 'test fail: b', 'done'].join('\n');
mock.module('@/lib/evidence-backend', () => ({
  getEvidenceS3Client: async () => ({
    send: async (cmd: any) => {
      bucketReads.push(cmd.input.Key);
      const body = gzipSync(LOG);
      return { Body: (async function* () { yield body; })() };
    },
  }),
}));
mock.module('@/lib/storage', () => ({ getDefaultStorageClient: () => { throw new Error('unexpected default bucket read'); } }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: async ({ where }: any) => {
        const t = TASKS[paramsOf(where)[0] as string];
        return t ? { id: t.id, workspaceId: t.workspaceId } : undefined;
      } },
      workers: { findMany: async ({ where }: any) => {
        const [ws, pr] = paramsOf(where);
        return WORKERS.filter(w => w.workspaceId === ws && w.prNumber === pr).map(w => ({ taskId: w.taskId }));
      } },
      evidenceObjects: {
        findMany: async ({ where }: any) => {
          const ws = paramsOf(where)[0];
          return OBJECTS.filter(o => o.workspaceId === ws);
        },
        findFirst: async ({ where }: any) => {
          const p = paramsOf(where);
          return OBJECTS.find(o => o.id === p[0] && o.workspaceId === p[1]);
        },
      },
      evidenceBackends: { findFirst: async () => ({ id: BACKEND, provider: 's3', bucket: 'team-bucket' }) },
    },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
}));

import { handleBuilddAction, type ActionContext } from '@buildd/core/mcp-tools';
import { createInProcessApi, routesFor } from './in-process-api';
import { CHAT_TOOL_SPECS } from './registry';

const reach = {
  teamId: 't-1',
  workspaceIds: new Set([WS_OK]),
  ownerOf: async (kind: string, id: string) => {
    if (kind !== 'task') return null;
    const t = TASKS[id];
    return t ? { teamId: t.teamId, workspaceId: t.workspaceId } : null;
  },
};

const ctx: ActionContext = {
  authType: 'oauth',
  workspaceId: WS_OK,
  getWorkspaceId: async () => WS_OK,
  getLevel: async () => 'worker',
};

function run(params: Record<string, unknown>) {
  const routes = routesFor(CHAT_TOOL_SPECS.read_evidence.ops[''].routes);
  const api = createInProcessApi({ origin: 'http://localhost', headers: new Headers({ cookie: 's=1' }), routes, reach });
  return handleBuilddAction(api, 'read_evidence', params, ctx)
    .then(r => ({ ok: !r.isError, text: r.content.map(c => c.text).join('\n') }))
    .catch((e: Error) => ({ ok: false, text: e.message }));
}

describe('read_evidence from chat (AC-5)', () => {
  beforeEach(() => { bucketReads.length = 0; });

  it('the registry declares exactly the two evidence routes (plus the workspace list)', () => {
    expect(CHAT_TOOL_SPECS.read_evidence.ops[''].routes).toEqual(['GET /api/workspaces', 'GET /api/tasks/:id/evidence', 'GET /api/evidence']);
  });

  it('in reach: {prNumber, kind: ci_job_log, grep} returns only the matching lines, within 64 KB', async () => {
    const r = await run({ prNumber: 7, workspaceId: WS_OK, kind: 'ci_job_log', grep: 'fail' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('3:FAIL src/a.test.ts');
    expect(r.text).toContain('5:test fail: b');
    for (const line of ['step 1 ok', 'Run tests', 'expected 1 got 2', 'done']) expect(r.text).not.toContain(line);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(64 * 1024);
    expect(bucketReads).toEqual([`evidence/${EV_OK}.log.gz`]);
  });

  it('refuses a PR in a sensitive workspace the user can otherwise open', async () => {
    const r = await run({ prNumber: 8, workspaceId: WS_SENSITIVE, kind: 'ci_job_log', grep: 'fail' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/404|not available to chat/);
    expect(bucketReads).toEqual([]);
  });

  it('refuses a PR in another team\'s workspace', async () => {
    const r = await run({ prNumber: 9, workspaceId: WS_OTHER_TEAM, grep: 'fail' });
    expect(r.ok).toBe(false);
    expect(bucketReads).toEqual([]);
  });

  it('refuses a task outside reach, by taskId', async () => {
    for (const taskId of [TASK_SENSITIVE, TASK_OTHER]) {
      const r = await run({ taskId, tail: 5 });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/not available to chat/);
    }
    expect(bucketReads).toEqual([]);
  });

  it('refuses an out-of-reach object smuggled under an in-reach task', async () => {
    const r = await run({ taskId: TASK_OK, evidenceId: EV_SENSITIVE, grep: 'fail' });
    expect(r.ok).toBe(false);
    expect(bucketReads).toEqual([]);
  });

  it('refuses an evidenceId lookup against an out-of-reach workspace', async () => {
    const r = await run({ evidenceId: EV_SENSITIVE, workspaceId: WS_SENSITIVE });
    expect(r.ok).toBe(false);
    expect(bucketReads).toEqual([]);
  });

  it('in reach by taskId: tail reads the task\'s object', async () => {
    const r = await run({ taskId: TASK_OK, tail: 2 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('test fail: b\ndone');
    expect(bucketReads).toEqual([`evidence/${EV_OK}.log.gz`]);
  });
});
