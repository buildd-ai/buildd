import { describe, it, expect, beforeEach } from 'bun:test';
import { gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import {
  captureCiJobLogEvidence,
  stripAnsi,
  type CiJobLogEvidenceDeps,
  type CiJobLogEvidenceInput,
  type EvidenceObjectInsert,
} from './ci-job-log-evidence';
import type { ResolvedEvidenceBackend } from './evidence-backend';

const TOKEN = 'ghs_seededInstallationToken0123456789abcdef';
const SERVER_SECRET = 'server-held-webhook-secret-value-xyz';

const LOG = [
  '2026-09-30T10:00:00.0000000Z \x1b[36;1mbun run test\x1b[0m',
  `2026-09-30T10:00:01.0000000Z Authorization: token ${TOKEN}`,
  `2026-09-30T10:00:02.0000000Z webhook=${SERVER_SECRET}`,
  '2026-09-30T10:00:03.0000000Z \x1b[31m(fail)\x1b[0m widget > renders',
  '2026-09-30T10:00:04.0000000Z \x1b]8;;https://example.com\x07link\x1b]8;;\x07 masked=***',
].join('\n');

function backend(over: Partial<ResolvedEvidenceBackend> = {}): ResolvedEvidenceBackend {
  return {
    source: 'team',
    backendId: 'backend-1',
    teamId: 'team-1',
    workspaceId: null,
    provider: 's3',
    bucket: 'tenant-bucket',
    endpoint: null,
    region: 'us-east-1',
    prefix: 'evidence',
    forcePathStyle: false,
    sse: 'AES256',
    kmsKeyId: null,
    retentionDays: 14,
    maxBytesPerTask: 50 * 1024 * 1024,
    status: 'ok',
    usable: true,
    problem: null,
    ...over,
  };
}

interface Put { Bucket: string; Key: string; Body: Buffer; ContentType?: string; ContentEncoding?: string; ServerSideEncryption?: string }

let puts: Put[];
let rows: EvidenceObjectInsert[];
let fetched: Array<{ token: string; repo: string; jobId: number }>;

function deps(over: Partial<CiJobLogEvidenceDeps> = {}): CiJobLogEvidenceDeps {
  return {
    getToken: async () => TOKEN,
    fetchJobLog: async (token, repo, jobId) => { fetched.push({ token, repo, jobId }); return LOG; },
    resolveBackend: async () => backend(),
    getClient: async () => ({
      send: async (cmd: any) => { puts.push(cmd.input as Put); return {}; },
    }),
    loadWorkspace: async () => ({ dataClass: 'standard' }),
    findRootTaskId: async () => 'root-task',
    insertRows: async (r) => { rows.push(...r); },
    serverSecretValues: () => [SERVER_SECRET],
    now: () => new Date('2026-09-30T12:00:00.000Z'),
    ...over,
  };
}

const input: CiJobLogEvidenceInput = {
  installationId: 42,
  repoFullName: 'acme/widgets',
  failedJobId: 777,
  workspaceId: 'ws-1',
  retryTaskId: 'retry-task',
  parentTaskId: 'prev-task',
  workerId: 'worker-1',
  prNumber: 12,
};

beforeEach(() => {
  puts = [];
  rows = [];
  fetched = [];
});

describe('stripAnsi', () => {
  it('removes CSI colour codes and OSC hyperlinks, keeps text', () => {
    expect(stripAnsi('\x1b[31;1mred\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07')).toBe('red link');
  });
});

describe('captureCiJobLogEvidence', () => {
  it('writes one gzipped object through the resolved backend under the evidence key', async () => {
    const res = await captureCiJobLogEvidence(input, deps());
    expect(res.status).toBe('stored');
    expect(fetched).toEqual([{ token: TOKEN, repo: 'acme/widgets', jobId: 777 }]);
    expect(puts).toHaveLength(1);
    const put = puts[0];
    expect(put.Bucket).toBe('tenant-bucket');
    expect(put.Key).toBe(`evidence/ws-1/root-task/retry-task/worker-1/ci_job_log/${Date.parse('2026-09-30T12:00:00.000Z')}-777.log.gz`);
    expect(put.ContentEncoding).toBe('gzip');
    expect(put.ServerSideEncryption).toBe('AES256');
  });

  it('strips escape sequences and redacts the installation token and server-held secrets', async () => {
    await captureCiJobLogEvidence(input, deps());
    const text = gunzipSync(puts[0].Body).toString('utf8');
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SERVER_SECRET);
    expect(text).toContain('(fail) widget > renders');
    // GitHub's own masking is kept
    expect(text).toContain('masked=***');
  });

  it('inserts pointer rows for both the retry task and its root task', async () => {
    await captureCiJobLogEvidence(input, deps());
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.taskId).sort()).toEqual(['retry-task', 'root-task']);
    const stored = gunzipSync(puts[0].Body);
    for (const r of rows) {
      expect(r.rootTaskId).toBe('root-task');
      expect(r.workspaceId).toBe('ws-1');
      expect(r.workerId).toBe('worker-1');
      expect(r.prNumber).toBe(12);
      expect(r.kind).toBe('ci_job_log');
      expect(r.backendId).toBe('backend-1');
      expect(r.objectKey).toBe(puts[0].Key);
      expect(r.uploadState).toBe('stored');
      expect(r.bytes).toBe(puts[0].Body.length);
      expect(r.sha256).toBe(createHash('sha256').update(stored).digest('hex'));
      expect(r.expiresAt?.toISOString()).toBe('2026-10-14T12:00:00.000Z');
    }
  });

  it('a thrown storage error is recorded as failed rows and does not reject', async () => {
    const res = await captureCiJobLogEvidence(input, deps({
      getClient: async () => ({ send: async () => { throw new Error('AccessDenied'); } }),
    }));
    expect(res.status).toBe('failed');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.uploadState === 'failed')).toBe(true);
  });

  it('a GitHub fetch failure is recorded as failed and does not reject', async () => {
    const res = await captureCiJobLogEvidence(input, deps({
      fetchJobLog: async () => { throw new Error('GitHub API error: 410'); },
    }));
    expect(res.status).toBe('failed');
    expect(puts).toHaveLength(0);
    expect(rows.every(r => r.uploadState === 'failed' && r.bytes === 0)).toBe(true);
  });

  it('never rejects, even when the pointer insert itself throws', async () => {
    const res = await captureCiJobLogEvidence(input, deps({
      getClient: async () => { throw new Error('bad endpoint'); },
      insertRows: async () => { throw new Error('db down'); },
    }));
    expect(res.status).toBe('failed');
  });

  it('skips when there is no failed job id', async () => {
    const res = await captureCiJobLogEvidence({ ...input, failedJobId: null }, deps());
    expect(res.status).toBe('skipped');
    expect(fetched).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it('writes nothing for a sensitive workspace without a BYO backend', async () => {
    const res = await captureCiJobLogEvidence(input, deps({
      loadWorkspace: async () => ({ dataClass: 'sensitive' }),
      resolveBackend: async () => backend({ source: 'buildd_default', provider: 'buildd_default', backendId: null }),
    }));
    expect(res.status).toBe('skipped');
    expect(fetched).toHaveLength(0);
    expect(puts).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it('writes to a BYO backend for a sensitive workspace', async () => {
    const res = await captureCiJobLogEvidence(input, deps({
      loadWorkspace: async () => ({ dataClass: 'sensitive' }),
    }));
    expect(res.status).toBe('stored');
    expect(rows.every(r => r.indexState === 'skipped')).toBe(true);
  });

  it('skips when the buildd-managed bucket is not configured', async () => {
    const res = await captureCiJobLogEvidence(input, deps({
      resolveBackend: async () => backend({ source: 'buildd_default', provider: 'buildd_default', backendId: null, usable: false, problem: 'not configured' }),
    }));
    expect(res.status).toBe('skipped');
    expect(rows).toHaveLength(0);
  });

  it('records failed rows when a BYO backend is unusable', async () => {
    const res = await captureCiJobLogEvidence(input, deps({
      resolveBackend: async () => backend({ usable: false, problem: 'no credential is set for this backend' }),
    }));
    expect(res.status).toBe('failed');
    expect(puts).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.uploadState === 'failed')).toBe(true);
  });

  it('refuses an object larger than the backend per-task cap', async () => {
    const res = await captureCiJobLogEvidence(input, deps({
      resolveBackend: async () => backend({ maxBytesPerTask: 10 }),
    }));
    expect(res.status).toBe('failed');
    expect(puts).toHaveLength(0);
  });

  it('writes a single row when the retry task is its own root', async () => {
    await captureCiJobLogEvidence(input, deps({ findRootTaskId: async () => 'retry-task' }));
    expect(rows).toHaveLength(1);
  });

  // One object, one index entry: the retry task's row is queued for the
  // evidence indexer; the root row points at the same object and is not
  // indexed a second time (its chunks carry rootTaskId anyway).
  it('queues the retry task\'s row for indexing and skips the root row', async () => {
    await captureCiJobLogEvidence(input, deps());
    const byTask = Object.fromEntries(rows.map(r => [r.taskId, r.indexState]));
    expect(byTask).toEqual({ 'retry-task': 'queued', 'root-task': 'skipped' });
  });

  it('queues the single row when the retry task is its own root', async () => {
    await captureCiJobLogEvidence(input, deps({ findRootTaskId: async () => 'retry-task' }));
    expect(rows.map(r => r.indexState)).toEqual(['queued']);
  });

  it('never queues a row whose upload failed', async () => {
    await captureCiJobLogEvidence(input, deps({ getClient: async () => { throw new Error('down'); } }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.uploadState === 'failed' && r.indexState === 'skipped')).toBe(true);
  });
});
