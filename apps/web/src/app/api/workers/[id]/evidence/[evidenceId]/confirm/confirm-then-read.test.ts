/**
 * End to end, across the two real routes and the real confirm/read libraries:
 * a runner upload is unreadable while `pending`, the runner's confirm HEADs the
 * object and marks it `stored`, and the same object then reads through
 * GET /api/tasks/[id]/evidence.
 *
 * Only the edges are faked: auth, an in-memory evidence_objects row, and an
 * in-memory bucket behind the S3 client.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { gzipSync } from 'zlib';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const WORKER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const TASK = '55555555-5555-4555-8555-555555555555';
const EVIDENCE = '88888888-8888-4888-8888-888888888888';
const KEY = `evidence/${WORKSPACE}/${TASK}/${TASK}/${WORKER}/command_output/1700000000000-0.log.gz`;

const LOG = ['$ bun run test', 'error: expect(received).toBe(expected)', 'Expected: 17', 'Received: 19', '(fail) ratchet > rejects a stale baseline'].join('\n');
const GZ = gzipSync(Buffer.from(LOG));

let row: Record<string, any>;
const bucket = new Map<string, Buffer>();

const s3 = {
  send: async (cmd: any) => {
    const name = cmd.constructor.name;
    const obj = bucket.get(cmd.input.Key);
    if (!obj) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    if (name === 'HeadObjectCommand') return { ContentLength: obj.length };
    if (name === 'GetObjectCommand') return { Body: (async function* () { yield obj; })() };
    throw new Error(`unexpected ${name}`);
  },
};

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => ({ id: ACCOUNT, teamId: TEAM }) }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => null }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async () => null,
  verifyAccountWorkspaceAccess: async (_a: string, ws: string) => ws === WORKSPACE,
}));
mock.module('@/lib/storage', () => ({ getDefaultStorageClient: () => s3 }));
mock.module('@/lib/evidence-backend', () => ({ getEvidenceS3Client: async () => s3 }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: async () => ({ id: WORKER, accountId: ACCOUNT, workspaceId: WORKSPACE, workspace: { teamId: TEAM } }) },
      tasks: { findFirst: async () => ({ id: TASK, workspaceId: WORKSPACE }) },
      evidenceObjects: { findFirst: async () => ({ ...row }), findMany: async () => [{ ...row }] },
      evidenceBackends: { findFirst: async () => null },
    },
    // Emulates the confirm write's `WHERE id = ? AND upload_state = 'pending'`.
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (row.uploadState !== 'pending') return [];
            row = { ...row, ...set };
            return [{ uploadState: row.uploadState, bytes: row.bytes }];
          },
        }),
      }),
    }),
  },
}));

const { POST: confirm } = await import('./route');
const { GET: readEvidence } = await import('../../../../../tasks/[id]/evidence/route');

const auth = { authorization: 'Bearer bld_test_key_value' };
const confirmReq = () => confirm(
  new NextRequest(`http://localhost:3000/api/workers/${WORKER}/evidence/${EVIDENCE}/confirm`, { method: 'POST', headers: auth }),
  { params: Promise.resolve({ id: WORKER, evidenceId: EVIDENCE }) },
);
const readReq = () => readEvidence(
  new NextRequest(`http://localhost:3000/api/tasks/${TASK}/evidence?evidenceId=${EVIDENCE}`, { headers: auth }),
  { params: Promise.resolve({ id: TASK }) },
);

beforeEach(() => {
  bucket.clear();
  row = {
    id: EVIDENCE, workspaceId: WORKSPACE, taskId: TASK, rootTaskId: TASK, workerId: WORKER, prNumber: null,
    kind: 'command_output', backendId: null, objectKey: KEY, bytes: GZ.length, sha256: null,
    uploadState: 'pending', indexState: 'queued', expiresAt: null,
    createdAt: new Date('2026-09-30T00:00:00Z'), updatedAt: new Date('2026-09-30T00:00:00Z'),
  };
});

describe('runner upload → confirm → read', () => {
  it('a pending upload is refused, and reads end to end once confirmed', async () => {
    bucket.set(KEY, GZ); // the runner's 2xx PUT

    const before = await readReq();
    expect(before.status).toBe(409);

    const res = await confirmReq();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evidenceId: EVIDENCE, uploadState: 'stored', bytes: GZ.length });
    expect(row.uploadState).toBe('stored');

    const read = await readReq();
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.text).toContain('Received: 19');
    expect(body.object.uploadState).toBe('stored');

    // Idempotent: confirming again changes nothing and still reads.
    expect(await (await confirmReq()).json()).toEqual({ evidenceId: EVIDENCE, uploadState: 'stored', bytes: GZ.length });
    expect((await readReq()).status).toBe(200);
  });

  it('a confirm with nothing in the bucket marks the row failed, and it stays unreadable', async () => {
    const res = await confirmReq();
    expect(res.status).toBe(200);
    expect((await res.json()).uploadState).toBe('failed');
    expect(row.indexState).toBe('skipped');
    expect((await readReq()).status).toBe(409);
  });

  it('a different-size object is failed, never served', async () => {
    bucket.set(KEY, Buffer.concat([GZ, Buffer.from('extra')]));
    const json = await (await confirmReq()).json();
    expect(json.uploadState).toBe('failed');
    expect(json.reason).toContain(String(GZ.length));
    expect((await readReq()).status).toBe(409);
  });
});
