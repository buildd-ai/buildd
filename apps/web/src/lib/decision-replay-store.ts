/**
 * The evidence-backend store behind `@buildd/core/decision-replay`: where a
 * decision's input is kept so an eval can ask another model the same question
 * (mission "Decision model evals", step 1).
 *
 * - **Where:** the decision's workspace backend, else its team's, else the
 *   buildd-managed bucket, resolved exactly as run evidence is
 *   (`resolveEvidenceBackend`). A decision with no workspace uses the team's
 *   own backend and is skipped when the team has none.
 * - **Never kept:** for a sensitive workspace, whatever its backend.
 * - **Redacted:** every string in the input goes through the credential-shape
 *   redactor plus the server's own secret values, one value at a time, so the
 *   JSON stays valid. Ids and counts stay: they are the input.
 * - **Expires** with the backend's retention: the copy carries `expiresAt` and
 *   a read past it is absent. Deleting the object is the bucket's lifecycle
 *   rule, as for run evidence.
 *
 * Collaborators are injectable; the defaults import the DB and S3 lazily.
 */
import { gunzipSync, gzipSync } from 'zlib';
import type { S3Client } from '@aws-sdk/client-s3';
import { createSecretRedactor } from '@buildd/core/redaction';
import type { DecisionReplayInput, DecisionReplayLocator, DecisionReplayStore } from '@buildd/core/decision-replay';
import { redactSecretShapes } from './ci-failure-excerpts';
import type { ResolvedEvidenceBackend } from './evidence-backend';
import { buildDecisionReplayKey } from './storage-keys';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StoredReplay {
  v: 1;
  expiresAt: string;
  input: DecisionReplayInput;
}

export interface DecisionReplayStoreDeps {
  /** The backend for a workspace, or for a team when there is no workspace (null: none). */
  resolveBackend(locator: Pick<DecisionReplayLocator, 'teamId' | 'workspaceId'>): Promise<ResolvedEvidenceBackend | null>;
  getClient(backend: ResolvedEvidenceBackend): Promise<Pick<S3Client, 'send'>>;
  loadWorkspace(workspaceId: string): Promise<{ dataClass: string | null } | null>;
  serverSecretValues(): string[];
  now(): Date;
  /** Run after the response when inside one; else fire and forget. */
  defer?(job: () => Promise<void>): void;
}

/** Redact every string in a JSON-shaped value; anything else passes through. */
export function redactReplayValue(value: unknown, redact: (s: string) => string, depth = 0): unknown {
  if (depth > 32) return null;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => redactReplayValue(v, redact, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactReplayValue(v, redact, depth + 1)]));
  }
  return value;
}

function isMissing(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

async function bodyBytes(body: unknown): Promise<Buffer> {
  const b = body as { transformToByteArray?: () => Promise<Uint8Array> } | AsyncIterable<Uint8Array> | null;
  if (b && typeof (b as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    return Buffer.from(await (b as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const c of b as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export function createDecisionReplayStore(deps: DecisionReplayStoreDeps = defaultDeps): DecisionReplayStore {
  const placed = async (locator: DecisionReplayLocator): Promise<{ backend: ResolvedEvidenceBackend; key: string } | null> => {
    if (locator.workspaceId) {
      const ws = await deps.loadWorkspace(locator.workspaceId);
      // A sensitive workspace keeps nothing, even on its own bucket.
      if (!ws || ws.dataClass === 'sensitive') return null;
    }
    const backend = await deps.resolveBackend(locator);
    if (!backend || !backend.usable) return null;
    return { backend, key: buildDecisionReplayKey(backend.prefix, locator.teamId, locator.capability, locator.decisionId) };
  };

  return {
    async put(locator, input) {
      const where = await placed(locator);
      if (!where) return 'skipped';
      const { backend, key } = where;
      const secrets = createSecretRedactor(deps.serverSecretValues().map(value => ({ value, label: 'server_secret' })));
      const redact = (s: string) => secrets(redactSecretShapes(s));
      const now = deps.now();
      const stored: StoredReplay = {
        v: 1,
        expiresAt: new Date(now.getTime() + backend.retentionDays * DAY_MS).toISOString(),
        input: {
          ...input,
          state: redactReplayValue(input.state, redact),
          candidates: input.candidates ? input.candidates.map(redact) : null,
          ruleAnswer: input.ruleAnswer === null ? null : redact(input.ruleAnswer),
        },
      };
      const body = gzipSync(Buffer.from(JSON.stringify(stored), 'utf8'));
      if (body.length > backend.maxBytesPerTask) return 'skipped';
      const client = await deps.getClient(backend);
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { evidenceSseParams } = await import('./evidence-backend');
      await client.send(new PutObjectCommand({
        Bucket: backend.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
        Expires: new Date(stored.expiresAt),
        ...evidenceSseParams(backend),
      }));
      return 'stored';
    },

    async get(locator) {
      const where = await placed(locator);
      if (!where) return null;
      const client = await deps.getClient(where.backend);
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      let raw: Buffer;
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: where.backend.bucket, Key: where.key }));
        raw = await bodyBytes((res as { Body?: unknown }).Body);
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
      let parsed: StoredReplay;
      try {
        // A gateway may hand back the body already decoded.
        const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
        parsed = JSON.parse(text) as StoredReplay;
      } catch {
        return null;
      }
      if (parsed?.v !== 1 || !parsed.input || parsed.input.decisionId !== locator.decisionId) return null;
      if (Date.parse(parsed.expiresAt) <= deps.now().getTime()) return null;
      return parsed.input;
    },

    defer: deps.defer,
  };
}

// ── Defaults ───────────────────────────────────────────────────────────────

const defaultDeps: DecisionReplayStoreDeps = {
  async resolveBackend({ teamId, workspaceId }) {
    const { resolveEvidenceBackend, describeEvidenceBackend } = await import('./evidence-backend');
    if (workspaceId) {
      const backend = await resolveEvidenceBackend(workspaceId);
      // Never place a copy in another team's bucket.
      return backend.teamId === null || backend.teamId === teamId ? backend : null;
    }
    const { db } = await import('@buildd/core/db');
    const { evidenceBackends } = await import('@buildd/core/db/schema');
    const { and, desc, eq, isNull } = await import('drizzle-orm');
    const row = await db.query.evidenceBackends.findFirst({
      where: sqlWhere(and(eq(evidenceBackends.teamId, teamId), isNull(evidenceBackends.workspaceId))),
      orderBy: sqlOrderBy(desc(evidenceBackends.createdAt)),
    });
    return row ? describeEvidenceBackend(row, 'team') : null;
  },
  async getClient(backend) {
    const { getEvidenceS3Client } = await import('./evidence-backend');
    const { getDefaultStorageClient } = await import('./storage');
    if (backend.provider === 'buildd_default' || !backend.backendId) return getDefaultStorageClient();
    const { db } = await import('@buildd/core/db');
    const { evidenceBackends } = await import('@buildd/core/db/schema');
    const { eq } = await import('drizzle-orm');
    const row = await db.query.evidenceBackends.findFirst({ where: sqlWhere(eq(evidenceBackends.id, backend.backendId)) });
    if (!row) throw new Error('the evidence backend no longer exists');
    return getEvidenceS3Client(row);
  },
  async loadWorkspace(workspaceId) {
    const { db } = await import('@buildd/core/db');
    const { workspaces } = await import('@buildd/core/db/schema');
    const { eq } = await import('drizzle-orm');
    const ws = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, workspaceId)), columns: { dataClass: true } });
    return ws ?? null;
  },
  serverSecretValues() {
    return [
      process.env.GITHUB_APP_CLIENT_SECRET,
      process.env.GITHUB_APP_WEBHOOK_SECRET,
      process.env.GITHUB_APP_PRIVATE_KEY,
      process.env.GITHUB_APP_PRIVATE_KEY_BASE64,
      process.env.ENCRYPTION_KEY,
      process.env.CRON_SECRET,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  },
  now: () => new Date(),
  defer(job) {
    // Inside a request, run after the response; outside one, `after` throws.
    void import('next/server')
      .then(({ after }) => { after(job); })
      .catch(() => { void job(); });
  },
};

/** Install the store for this process (instrumentation.ts). */
export async function startDecisionReplayStore(): Promise<void> {
  const { registerDecisionReplayStore } = await import('@buildd/core/decision-replay');
  registerDecisionReplayStore(createDecisionReplayStore());
}
