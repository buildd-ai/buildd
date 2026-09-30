/**
 * `ci_job_log` evidence (docs/specs/byo-evidence-storage.md, "What gets
 * written", AC-3).
 *
 * When a CI failure on a buildd-owned PR produces a retry task, the failed
 * job's log is fetched with the GitHub App installation token, stripped of
 * ANSI escape sequences, redacted as a whole text, gzipped, and written
 * server-side through the workspace's resolved evidence backend. One object,
 * pointer rows for both the retry task and the root task of its chain.
 *
 * Best-effort by contract: a GitHub, storage or database failure is recorded
 * (upload_state = failed) where it can be and never thrown. The caller is the
 * CI-failure webhook, and nothing here may cost the PR its retry.
 *
 * Every collaborator is injectable; the defaults import the DB and GitHub
 * modules lazily so the logic can be tested without mocking them.
 */
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import type { S3Client } from '@aws-sdk/client-s3';
import { createSecretRedactor } from '@buildd/core/redaction';
import type { ResolvedEvidenceBackend } from './evidence-backend';
import { buildEvidenceObjectKey } from './storage-keys';

export interface CiJobLogEvidenceInput {
  installationId: number;
  repoFullName: string;
  /** The first failed job of the run (CIFailureInfo.failedJobId). */
  failedJobId: number | null;
  workspaceId: string;
  /** The retry task the webhook just created. */
  retryTaskId: string;
  /** The task the retry re-attempts; the root is found by walking up from it. */
  parentTaskId: string;
  /** The worker whose PR failed CI; evidence_objects.worker_id is required. */
  workerId: string;
  prNumber: number | null;
}

export interface EvidenceObjectInsert {
  workspaceId: string;
  taskId: string;
  rootTaskId: string;
  workerId: string;
  prNumber: number | null;
  kind: 'ci_job_log';
  backendId: string | null;
  objectKey: string;
  bytes: number;
  sha256: string | null;
  uploadState: 'stored' | 'failed';
  indexState: 'skipped' | 'queued';
  expiresAt: Date | null;
}

export interface CiJobLogEvidenceDeps {
  getToken(installationId: number): Promise<string>;
  fetchJobLog(token: string, repoFullName: string, jobId: number): Promise<string>;
  resolveBackend(workspaceId: string): Promise<ResolvedEvidenceBackend>;
  getClient(backend: ResolvedEvidenceBackend): Promise<Pick<S3Client, 'send'>>;
  loadWorkspace(workspaceId: string): Promise<{ dataClass: string | null } | null>;
  findRootTaskId(taskId: string): Promise<string>;
  insertRows(rows: EvidenceObjectInsert[]): Promise<void>;
  /** Secret values the server holds that a log could echo; exact-value redacted. */
  serverSecretValues(): string[];
  now(): Date;
}

export type CiJobLogEvidenceResult =
  | { status: 'stored'; objectKey: string; bytes: number }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string };

// CSI (colours, cursor), OSC (hyperlinks, titles; BEL or ST terminated), and
// the remaining two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** A single job log is megabytes; refuse anything past this before gzip. */
const MAX_LOG_CHARS = 64 * 1024 * 1024;

const MAX_LINEAGE_DEPTH = 50;

export async function captureCiJobLogEvidence(
  input: CiJobLogEvidenceInput,
  deps: CiJobLogEvidenceDeps = defaultDeps,
): Promise<CiJobLogEvidenceResult> {
  try {
    return await capture(input, deps);
  } catch (err) {
    const error = errorMessage(err);
    console.warn(`[ci-job-log-evidence] ${input.repoFullName}#${input.prNumber ?? '?'}: ${error}`);
    return { status: 'failed', error };
  }
}

async function capture(input: CiJobLogEvidenceInput, deps: CiJobLogEvidenceDeps): Promise<CiJobLogEvidenceResult> {
  if (input.failedJobId === null) return { status: 'skipped', reason: 'no failed job id' };

  const [backend, workspace] = await Promise.all([
    deps.resolveBackend(input.workspaceId),
    deps.loadWorkspace(input.workspaceId),
  ]);
  if (backend.provider === 'buildd_default') {
    // A sensitive workspace never writes to the buildd-managed bucket (AC-7).
    if (workspace?.dataClass === 'sensitive') return { status: 'skipped', reason: 'sensitive workspace without a BYO backend' };
    if (!backend.usable) return { status: 'skipped', reason: backend.problem ?? 'storage not configured' };
  }

  const now = deps.now();
  const rootTaskId = await deps.findRootTaskId(input.parentTaskId);
  const objectKey = buildEvidenceObjectKey(
    backend.prefix, input.workspaceId, rootTaskId, input.retryTaskId, input.workerId,
    'ci_job_log', `${now.getTime()}-${input.failedJobId}.log.gz`,
  );
  const expiresAt = new Date(now.getTime() + backend.retentionDays * 24 * 60 * 60 * 1000);
  const taskIds = [...new Set([input.retryTaskId, rootTaskId])];

  const sensitive = workspace?.dataClass === 'sensitive';
  const record = async (fields: Pick<EvidenceObjectInsert, 'bytes' | 'sha256' | 'uploadState'>) => {
    await deps.insertRows(taskIds.map(taskId => ({
      workspaceId: input.workspaceId,
      taskId,
      rootTaskId,
      workerId: input.workerId,
      prNumber: input.prNumber,
      kind: 'ci_job_log' as const,
      backendId: backend.backendId,
      objectKey,
      // The evidence indexer picks up `queued` rows. One object gets one index
      // entry: only the retry task's row is queued (its chunks carry rootTaskId),
      // a failed upload has nothing to index, and a sensitive workspace is never
      // sent to the embedder (invariant 7).
      indexState: (taskId === input.retryTaskId && fields.uploadState === 'stored' && !sensitive)
        ? 'queued' as const
        : 'skipped' as const,
      expiresAt,
      ...fields,
    })));
  };

  const fail = async (error: string): Promise<CiJobLogEvidenceResult> => {
    try {
      await record({ bytes: 0, sha256: null, uploadState: 'failed' });
    } catch (err) {
      console.warn(`[ci-job-log-evidence] could not record failure for ${objectKey}: ${errorMessage(err)}`);
    }
    console.warn(`[ci-job-log-evidence] ${input.repoFullName}#${input.prNumber ?? '?'} job ${input.failedJobId}: ${error}`);
    return { status: 'failed', error };
  };

  if (!backend.usable) return fail(backend.problem ?? 'evidence backend is unusable');

  let redacted: string;
  try {
    const token = await deps.getToken(input.installationId);
    const raw = await deps.fetchJobLog(token, input.repoFullName, input.failedJobId);
    if (raw.length > MAX_LOG_CHARS) return fail(`job log exceeds ${MAX_LOG_CHARS} characters`);
    const redact = createSecretRedactor([
      { value: token, label: 'github_installation_token' },
      ...deps.serverSecretValues().map(value => ({ value, label: 'server_secret' })),
    ]);
    redacted = redact(stripAnsi(raw));
  } catch (err) {
    return fail(`could not read job log: ${errorMessage(err)}`);
  }

  const plain = Buffer.from(redacted, 'utf8');
  const body = gzipSync(plain);
  if (body.length > backend.maxBytesPerTask) {
    return fail(`object of ${body.length} bytes exceeds the backend's per-task limit of ${backend.maxBytesPerTask}`);
  }

  try {
    const client = await deps.getClient(backend);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { evidenceSseParams } = await import('./evidence-backend');
    await client.send(new PutObjectCommand({
      Bucket: backend.bucket,
      Key: objectKey,
      Body: body,
      ContentType: 'text/plain; charset=utf-8',
      ContentEncoding: 'gzip',
      ...evidenceSseParams(backend),
    }));
  } catch (err) {
    return fail(`storage write failed: ${errorMessage(err)}`);
  }

  await record({
    bytes: body.length,
    sha256: createHash('sha256').update(plain).digest('hex'),
    uploadState: 'stored',
  });
  return { status: 'stored', objectKey, bytes: body.length };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Defaults ───────────────────────────────────────────────────────────────

const defaultDeps: CiJobLogEvidenceDeps = {
  async getToken(installationId) {
    const { getInstallationToken } = await import('./github');
    return getInstallationToken(installationId);
  },
  async fetchJobLog(token, repoFullName, jobId) {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/actions/jobs/${jobId}/logs`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    return res.text();
  },
  async resolveBackend(workspaceId) {
    const { resolveEvidenceBackend } = await import('./evidence-backend');
    return resolveEvidenceBackend(workspaceId);
  },
  async getClient(backend) {
    const { getEvidenceS3Client } = await import('./evidence-backend');
    const { getDefaultStorageClient } = await import('./storage');
    if (backend.provider === 'buildd_default' || !backend.backendId) return getDefaultStorageClient();
    const { db } = await import('@buildd/core/db');
    const { evidenceBackends } = await import('@buildd/core/db/schema');
    const { eq } = await import('drizzle-orm');
    const row = await db.query.evidenceBackends.findFirst({ where: eq(evidenceBackends.id, backend.backendId) });
    if (!row) throw new Error('the evidence backend no longer exists');
    return getEvidenceS3Client(row);
  },
  async loadWorkspace(workspaceId) {
    const { db } = await import('@buildd/core/db');
    const { workspaces } = await import('@buildd/core/db/schema');
    const { eq } = await import('drizzle-orm');
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { dataClass: true },
    });
    return ws ?? null;
  },
  async findRootTaskId(taskId) {
    const { db } = await import('@buildd/core/db');
    const { tasks } = await import('@buildd/core/db/schema');
    const { eq } = await import('drizzle-orm');
    let current = taskId;
    const seen = new Set<string>();
    for (let i = 0; i < MAX_LINEAGE_DEPTH && !seen.has(current); i++) {
      seen.add(current);
      const t = await db.query.tasks.findFirst({
        where: eq(tasks.id, current),
        columns: { parentTaskId: true },
      });
      if (!t?.parentTaskId) break;
      current = t.parentTaskId;
    }
    return current;
  },
  async insertRows(rows) {
    const { db } = await import('@buildd/core/db');
    const { evidenceObjects } = await import('@buildd/core/db/schema');
    await db.insert(evidenceObjects).values(rows);
  },
  serverSecretValues() {
    return [
      process.env.GITHUB_APP_CLIENT_SECRET,
      process.env.GITHUB_APP_WEBHOOK_SECRET,
      process.env.GITHUB_APP_PRIVATE_KEY,
      process.env.GITHUB_APP_PRIVATE_KEY_BASE64,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  },
  now: () => new Date(),
};
