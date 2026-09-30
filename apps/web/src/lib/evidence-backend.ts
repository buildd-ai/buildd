/**
 * Evidence storage backends (docs/specs/byo-evidence-storage.md, "Backend
 * configuration").
 *
 * - `resolveEvidenceBackend(workspaceId)`: workspace backend → team backend →
 *   `buildd_default`. The most specific row wins outright: one whose credential
 *   is unusable resolves as unusable, it never falls through to a wider one, so
 *   evidence never lands in a bucket the team did not pick for that workspace.
 * - `getEvidenceS3Client`: the per-backend S3 client. The single env-configured
 *   client in storage.ts stays as it is and serves only `buildd_default`.
 * - `verifyEvidenceBackend`: PUT, GET, DELETE of one probe object. It never
 *   lists, never throws, and never touches a task or worker row.
 * - `validateEvidenceEndpoint`: refuses a tenant-supplied endpoint that points
 *   at a private or link-local address.
 *
 * Credentials are read only inside this module, decrypted into a client, and
 * never appear on a returned value.
 */
import { randomUUID } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import {
  DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '@buildd/core/config';
import { db } from '@buildd/core/db';
import { evidenceBackends, secrets, workspaces } from '@buildd/core/db/schema';
import { decrypt } from '@buildd/core/secrets';
import { and, eq, isNull, or } from 'drizzle-orm';
import { recordCredentialAuthSuccess } from './credential-health';
import { getDefaultStorageClient, isStorageConfigured } from './storage';
import { assertNormalizedObjectKey, buildEvidenceProbeKey } from './storage-keys';

export const EVIDENCE_CREDENTIAL_PURPOSE = 'evidence_storage_credential' as const;

export type EvidenceProvider = 's3' | 'r2' | 's3_compatible' | 'buildd_default';
export type EvidenceSse = 'none' | 'AES256' | 'aws:kms';
export type EvidenceBackendSource = 'workspace' | 'team' | 'buildd_default';
export type EvidenceBackendRow = typeof evidenceBackends.$inferSelect;

/** Key prefix when a backend names none. */
export const DEFAULT_EVIDENCE_PREFIX = 'evidence';
/** `buildd_default` keeps evidence for a fixed 30 days (spec, "Retention"). */
export const BUILDD_DEFAULT_RETENTION_DAYS = 30;
const BUILDD_DEFAULT_MAX_BYTES_PER_TASK = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

export interface ResolvedEvidenceBackend {
  source: EvidenceBackendSource;
  /** The `evidence_backends` row this came from; null for the env-configured default with no row. */
  backendId: string | null;
  teamId: string | null;
  /** The row's own workspace scope (null for a team default or `buildd_default`). */
  workspaceId: string | null;
  provider: EvidenceProvider;
  bucket: string;
  endpoint: string | null;
  region: string | null;
  prefix: string;
  forcePathStyle: boolean;
  sse: EvidenceSse;
  kmsKeyId: string | null;
  retentionDays: number;
  maxBytesPerTask: number;
  status: 'unverified' | 'ok' | 'failing';
  /** False when writes to this backend cannot work; callers record the failure and carry on. */
  usable: boolean;
  problem: string | null;
}

export interface EvidenceCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

// ── Endpoint validation (SSRF) ─────────────────────────────────────────────

export type ResolveHost = (hostname: string) => Promise<string[]>;

const defaultResolveHost: ResolveHost = async (hostname) => {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map(f => f.address);
};

function isBlockedIpv4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224; // multicast, reserved, broadcast
}

/** Eight 16-bit groups of an IPv6 literal, or null when it does not parse. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (isIP(dotted[2]) !== 4) return null;
    const [a, b, c, d] = dotted[2].split('.').map(Number);
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for a loopback, private, link-local, multicast or otherwise non-public address. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.every(x => x === 0)) return true; // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isBlockedIpv4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return isBlockedIpv4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedIpv4(embeddedV4(g[1], g[2])); // 6to4
  return false;
}

export type EndpointCheck = { ok: true } | { ok: false; error: string };

/**
 * A tenant-supplied endpoint must be https, carry no credentials, and resolve
 * only to public addresses. Checked when a backend is saved and again before
 * the server connects to it (DNS can change), so a hostname that later points
 * inward is refused too.
 */
export async function validateEvidenceEndpoint(endpoint: string, resolveHost: ResolveHost = defaultResolveHost): Promise<EndpointCheck> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: 'endpoint must be a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'endpoint must use https' };
  if (url.username || url.password) return { ok: false, error: 'endpoint must not contain credentials' };

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, error: 'endpoint has no host' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: 'endpoint must not point at a private or link-local address' };
  }

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolveHost(host);
    } catch {
      return { ok: false, error: `endpoint host "${host}" could not be resolved` };
    }
    if (addresses.length === 0) return { ok: false, error: `endpoint host "${host}" could not be resolved` };
  }
  if (addresses.some(isBlockedAddress)) {
    return { ok: false, error: 'endpoint must not point at a private or link-local address' };
  }
  return { ok: true };
}

// ── Resolution ─────────────────────────────────────────────────────────────

function newest(a: EvidenceBackendRow, b: EvidenceBackendRow): number {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

function bucketDefault(source: EvidenceBackendSource, row: EvidenceBackendRow | null, teamId: string | null): ResolvedEvidenceBackend {
  const configured = isStorageConfigured();
  return {
    source,
    backendId: row?.id ?? null,
    teamId,
    workspaceId: row?.workspaceId ?? null,
    provider: 'buildd_default',
    bucket: config.storageBucket,
    endpoint: config.storageEndpoint || null,
    region: config.storageRegion || null,
    prefix: DEFAULT_EVIDENCE_PREFIX,
    forcePathStyle: true,
    sse: 'none',
    kmsKeyId: null,
    retentionDays: BUILDD_DEFAULT_RETENTION_DAYS,
    maxBytesPerTask: row?.maxBytesPerTask ?? BUILDD_DEFAULT_MAX_BYTES_PER_TASK,
    status: row?.status ?? 'unverified',
    usable: configured,
    problem: configured ? null : 'the buildd-managed storage bucket is not configured',
  };
}

/**
 * The resolved description of one backend row. A row whose credential cannot be
 * used (missing, or a secret from another team, or the wrong purpose) comes
 * back with `usable: false`; it is not swapped for another backend.
 */
export async function describeEvidenceBackend(row: EvidenceBackendRow, source: EvidenceBackendSource): Promise<ResolvedEvidenceBackend> {
  if (row.provider === 'buildd_default') return bucketDefault(source, row, row.teamId);

  const base: ResolvedEvidenceBackend = {
    source,
    backendId: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId ?? null,
    provider: row.provider,
    bucket: row.bucket,
    endpoint: row.endpoint ?? null,
    region: row.region ?? null,
    prefix: row.prefix || DEFAULT_EVIDENCE_PREFIX,
    forcePathStyle: row.forcePathStyle,
    sse: row.sse,
    kmsKeyId: row.kmsKeyId ?? null,
    retentionDays: row.retentionDays,
    maxBytesPerTask: row.maxBytesPerTask,
    status: row.status,
    usable: true,
    problem: null,
  };

  const problem = await credentialProblem(row);
  return problem ? { ...base, usable: false, problem } : base;
}

async function credentialProblem(row: EvidenceBackendRow): Promise<string | null> {
  if (!row.credentialSecretId) return 'no credential is set for this backend';
  const secret = await db.query.secrets.findFirst({
    where: eq(secrets.id, row.credentialSecretId),
    columns: { id: true, teamId: true, purpose: true },
  });
  if (!secret) return 'the credential for this backend no longer exists';
  if (secret.teamId !== row.teamId) return 'the credential belongs to a different team than the backend';
  if (secret.purpose !== EVIDENCE_CREDENTIAL_PURPOSE) return 'the credential is not an evidence storage credential';
  return null;
}

/**
 * Where a workspace's evidence goes: its own backend, else its team's default
 * backend, else the buildd-managed bucket.
 */
export async function resolveEvidenceBackend(workspaceId: string): Promise<ResolvedEvidenceBackend> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { id: true, teamId: true },
  });
  if (!ws) return bucketDefault('buildd_default', null, null);

  const rows = ((await db.query.evidenceBackends.findMany({
    where: and(eq(evidenceBackends.teamId, ws.teamId), or(eq(evidenceBackends.workspaceId, ws.id), isNull(evidenceBackends.workspaceId))),
  })) as EvidenceBackendRow[]).filter(r => r.teamId === ws.teamId);

  const own = rows.filter(r => r.workspaceId === ws.id).sort(newest)[0];
  if (own) return describeEvidenceBackend(own, 'workspace');
  const team = rows.filter(r => r.workspaceId === null).sort(newest)[0];
  if (team) return describeEvidenceBackend(team, 'team');
  return bucketDefault('buildd_default', null, ws.teamId);
}

// ── S3 client ──────────────────────────────────────────────────────────────

const REGION_DEFAULT: Record<Exclude<EvidenceProvider, 'buildd_default'>, string> = {
  s3: 'us-east-1',
  r2: 'auto',
  s3_compatible: 'us-east-1',
};

export function createEvidenceS3Client(
  backend: Pick<ResolvedEvidenceBackend, 'provider' | 'endpoint' | 'region' | 'forcePathStyle'>,
  credentials: EvidenceCredentials,
): S3Client {
  const provider = backend.provider === 'buildd_default' ? 's3_compatible' : backend.provider;
  return new S3Client({
    region: backend.region || REGION_DEFAULT[provider],
    ...(backend.endpoint ? { endpoint: backend.endpoint } : {}),
    forcePathStyle: backend.forcePathStyle,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
    maxAttempts: 2,
  });
}

export function parseEvidenceCredentials(raw: unknown): EvidenceCredentials | null {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const { accessKeyId, secretAccessKey, sessionToken } = v as Record<string, unknown>;
  if (typeof accessKeyId !== 'string' || !accessKeyId.trim()) return null;
  if (typeof secretAccessKey !== 'string' || !secretAccessKey.trim()) return null;
  if (sessionToken !== undefined && sessionToken !== null && typeof sessionToken !== 'string') return null;
  return {
    accessKeyId: accessKeyId.trim(),
    secretAccessKey: secretAccessKey.trim(),
    ...(typeof sessionToken === 'string' && sessionToken.trim() ? { sessionToken: sessionToken.trim() } : {}),
  };
}

/** Decrypts the backend's credential, re-checking that its secret belongs to the backend's team. */
async function loadCredentials(row: EvidenceBackendRow): Promise<EvidenceCredentials> {
  if (!row.credentialSecretId) throw new Error('no credential is set for this backend');
  const secret = await db.query.secrets.findFirst({
    where: eq(secrets.id, row.credentialSecretId),
    columns: { id: true, teamId: true, purpose: true, encryptedValue: true },
  });
  if (!secret) throw new Error('the credential for this backend no longer exists');
  if (secret.teamId !== row.teamId) throw new Error('the credential belongs to a different team than the backend');
  if (secret.purpose !== EVIDENCE_CREDENTIAL_PURPOSE) throw new Error('the credential is not an evidence storage credential');
  const creds = parseEvidenceCredentials(decrypt(secret.encryptedValue));
  if (!creds) throw new Error('the stored credential could not be read');
  return creds;
}

/**
 * A client for a backend row. Refuses an endpoint that no longer resolves to a
 * public address. `buildd_default` gets the env-configured client.
 */
export async function getEvidenceS3Client(
  row: EvidenceBackendRow,
  opts: { resolveHost?: ResolveHost } = {},
): Promise<S3Client> {
  if (row.provider === 'buildd_default') return getDefaultStorageClient();
  if (row.endpoint) {
    const check = await validateEvidenceEndpoint(row.endpoint, opts.resolveHost);
    if (!check.ok) throw new Error(check.error);
  }
  const credentials = await loadCredentials(row);
  return createEvidenceS3Client(
    { provider: row.provider, endpoint: row.endpoint ?? null, region: row.region ?? null, forcePathStyle: row.forcePathStyle },
    credentials,
  );
}

/** Server-side-encryption fields for a PUT or a presigned PUT; SSE must be signed, so pass them to the signer. */
export function evidenceSseParams(backend: Pick<ResolvedEvidenceBackend, 'sse' | 'kmsKeyId'>):
  { ServerSideEncryption?: 'AES256' | 'aws:kms'; SSEKMSKeyId?: string } {
  if (backend.sse === 'AES256') return { ServerSideEncryption: 'AES256' };
  if (backend.sse === 'aws:kms') return { ServerSideEncryption: 'aws:kms', ...(backend.kmsKeyId ? { SSEKMSKeyId: backend.kmsKeyId } : {}) };
  return {};
}

/** Presigned evidence PUTs are valid for 15 minutes (spec, invariant 2). */
export const EVIDENCE_UPLOAD_EXPIRY_SECONDS = 15 * 60;

/**
 * Presign a PUT of exactly `sizeBytes` to `key` on the resolved backend.
 *
 * `content-length` is a signed header, so a body of any other length fails
 * SigV4 at the bucket. SSE fields go into the signed request. The URL carries
 * the access key id (as every SigV4 presigned URL does) but never the secret.
 * Throws on an unusable backend or a signing failure; callers turn that into a
 * refusal.
 */
export async function generateEvidenceUploadUrl(
  backend: ResolvedEvidenceBackend,
  key: string,
  sizeBytes: number,
  opts: { resolveHost?: ResolveHost } = {},
): Promise<string> {
  assertNormalizedObjectKey(key);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('sizeBytes must be a positive integer');
  }
  if (!backend.usable) throw new Error(backend.problem ?? 'backend is not usable');

  let client: S3Client;
  if (!backend.backendId) {
    client = getDefaultStorageClient();
  } else {
    const row = await db.query.evidenceBackends.findFirst({ where: eq(evidenceBackends.id, backend.backendId) });
    if (!row) throw new Error('backend not found');
    client = await getEvidenceS3Client(row as EvidenceBackendRow, opts);
  }

  const command = new PutObjectCommand({
    Bucket: backend.bucket,
    Key: key,
    ContentLength: sizeBytes,
    ...evidenceSseParams(backend),
  });
  return getSignedUrl(client, command, {
    expiresIn: EVIDENCE_UPLOAD_EXPIRY_SECONDS,
    signableHeaders: new Set(['content-length']),
  });
}

// ── Verification ───────────────────────────────────────────────────────────

export interface EvidenceVerifyResult {
  backendId: string;
  status: 'ok' | 'failing';
  error: string | null;
  /** Non-fatal findings: a public probe object, a probe that could not be deleted. */
  warnings: string[];
  verifiedAt: string;
}

export interface VerifyOptions {
  /** Test seam: the client used instead of one built from the stored credential. */
  client?: Pick<S3Client, 'send'>;
  fetchImpl?: typeof fetch;
  resolveHost?: ResolveHost;
  now?: () => Date;
}

const REJECTED_CREDENTIAL_ERRORS = new Set([
  'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken', 'TokenRefreshRequired',
]);

function s3ErrorInfo(err: unknown): { name: string; status: number | undefined; text: string; rejected: boolean } {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name && e.name !== 'Error' ? e.name : '';
  const status = e?.$metadata?.httpStatusCode;
  const timedOut = name === 'AbortError' || name === 'TimeoutError';
  const message = timedOut ? 'timed out' : (e?.message ?? String(err)).replace(/\s+/g, ' ').trim();
  const parts = [timedOut ? 'timeout' : name, status ? `HTTP ${status}` : ''].filter(Boolean).join(' ');
  return {
    name,
    status,
    text: `${parts ? `${parts}: ` : ''}${message}`.slice(0, 300),
    rejected: REJECTED_CREDENTIAL_ERRORS.has(name) || status === 401,
  };
}

function probeUrl(backend: ResolvedEvidenceBackend, key: string): string | null {
  try {
    if (backend.endpoint) {
      const ep = new URL(backend.endpoint);
      const base = ep.pathname.replace(/\/$/, '');
      return backend.forcePathStyle
        ? `${ep.origin}${base}/${backend.bucket}/${key}`
        : `${ep.protocol}//${backend.bucket}.${ep.host}${base}/${key}`;
    }
    const region = backend.region || 'us-east-1';
    return backend.forcePathStyle
      ? `https://s3.${region}.amazonaws.com/${backend.bucket}/${key}`
      : `https://${backend.bucket}.s3.${region}.amazonaws.com/${key}`;
  } catch {
    return null;
  }
}

async function readableAnonymously(backend: ResolvedEvidenceBackend, key: string, fetchImpl: typeof fetch): Promise<boolean> {
  const url = probeUrl(backend, key);
  if (!url) return false;
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    void res.body?.cancel().catch(() => {});
    return res.status === 200;
  } catch {
    return false;
  }
}

interface ProbeOutcome {
  error: string | null;
  rejected: boolean;
  warnings: string[];
}

async function runProbe(
  backend: ResolvedEvidenceBackend,
  client: Pick<S3Client, 'send'>,
  fetchImpl: typeof fetch,
): Promise<ProbeOutcome> {
  const key = buildEvidenceProbeKey(backend.prefix, randomUUID());
  const body = `buildd evidence probe ${new Date().toISOString()}`;
  const signal = () => ({ abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const warnings: string[] = [];

  try {
    await client.send(new PutObjectCommand({
      Bucket: backend.bucket, Key: key, Body: body, ContentType: 'text/plain', ...evidenceSseParams(backend),
    }), signal());
  } catch (err) {
    const info = s3ErrorInfo(err);
    return { error: `PUT failed: ${info.text}`, rejected: info.rejected, warnings };
  }

  let error: string | null = null;
  let rejected = false;
  try {
    const got = await client.send(new GetObjectCommand({ Bucket: backend.bucket, Key: key }), signal());
    const text = await (got as { Body?: { transformToString?: () => Promise<string> } }).Body?.transformToString?.();
    if (text !== body) error = 'GET returned different content than the probe PUT wrote';
  } catch (err) {
    const info = s3ErrorInfo(err);
    error = `GET failed: ${info.text}`;
    rejected = info.rejected;
  }

  if (!error && await readableAnonymously(backend, key, fetchImpl)) {
    warnings.push('the probe object is readable without credentials: this bucket allows public reads, and run evidence would be world-readable');
  }

  try {
    await client.send(new DeleteObjectCommand({ Bucket: backend.bucket, Key: key }), signal());
  } catch (err) {
    warnings.push(`the probe object could not be deleted (${s3ErrorInfo(err).text}); grant DeleteObject or expire the ${key.split('/').slice(0, 2).join('/')}/ prefix with a lifecycle rule`);
  }

  return { error, rejected, warnings };
}

async function record(step: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[evidence-backend] ${step} failed:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Probe one backend and record the outcome on the row and on its credential's
 * health columns. Any failure, including a failed write of the result itself,
 * is contained here: a broken bucket is a `failing` status, never an exception
 * to the caller and never a change to a task or worker.
 */
export async function verifyEvidenceBackend(backendId: string, opts: VerifyOptions = {}): Promise<EvidenceVerifyResult> {
  const now = (opts.now ?? (() => new Date()))();
  const verifiedAt = now.toISOString();
  const fail = (error: string): EvidenceVerifyResult => ({ backendId, status: 'failing', error, warnings: [], verifiedAt });

  let row: EvidenceBackendRow | undefined;
  try {
    row = await db.query.evidenceBackends.findFirst({ where: eq(evidenceBackends.id, backendId) });
  } catch (err) {
    return fail(`could not load the backend: ${err instanceof Error ? err.message : 'unknown error'}`.slice(0, 300));
  }
  if (!row) return fail('backend not found');
  const backend = row;

  let outcome: ProbeOutcome;
  try {
    const resolved = await describeEvidenceBackend(backend, backend.workspaceId ? 'workspace' : 'team');
    if (!resolved.usable) {
      outcome = { error: resolved.problem ?? 'backend is not usable', rejected: false, warnings: [] };
    } else {
      const client = opts.client ?? await getEvidenceS3Client(backend, { resolveHost: opts.resolveHost });
      outcome = await runProbe(resolved, client, opts.fetchImpl ?? fetch);
    }
  } catch (err) {
    outcome = { error: (err instanceof Error ? err.message : 'probe failed').slice(0, 300), rejected: false, warnings: [] };
  }

  const status: 'ok' | 'failing' = outcome.error ? 'failing' : 'ok';
  const warningText = outcome.warnings.length ? `warning: ${outcome.warnings.join('; ')}`.slice(0, 500) : null;
  const lastError = outcome.error ? outcome.error.slice(0, 500) : warningText;

  await record('backend status write', () => db.update(evidenceBackends)
    .set({ status, lastVerifiedAt: now, lastError, updatedAt: now })
    .where(eq(evidenceBackends.id, backend.id)));

  const secretId = backend.credentialSecretId;
  if (secretId && backend.provider !== 'buildd_default') {
    await record('credential health write', async () => {
      await db.update(secrets)
        .set({ lastVerifiedAt: now, lastVerificationError: outcome.error ? outcome.error.slice(0, 500) : null, updatedAt: now })
        .where(eq(secrets.id, secretId));
      if (!outcome.error) {
        await recordCredentialAuthSuccess(secretId);
      } else if (outcome.rejected) {
        await db.update(secrets)
          .set({ healthStatus: 'revoked', lastFailureAt: now, lastFailureMessage: outcome.error!.slice(0, 500), updatedAt: now })
          .where(eq(secrets.id, secretId));
      }
    });
  }

  return { backendId: backend.id, status, error: outcome.error, warnings: outcome.warnings, verifiedAt };
}

// ── Wire shape ─────────────────────────────────────────────────────────────

export interface EvidenceBackendDTO {
  id: string;
  workspaceId: string | null;
  provider: EvidenceProvider;
  endpoint: string | null;
  region: string | null;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  sse: EvidenceSse;
  kmsKeyId: string | null;
  retentionDays: number;
  maxBytesPerTask: number;
  status: 'unverified' | 'ok' | 'failing';
  lastVerifiedAt: string | null;
  lastError: string | null;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** What API and MCP callers see. The credential is reported as present or absent, never by id or value. */
export function toEvidenceBackendDTO(row: EvidenceBackendRow): EvidenceBackendDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? null,
    provider: row.provider,
    endpoint: row.endpoint ?? null,
    region: row.region ?? null,
    bucket: row.bucket,
    prefix: row.prefix || DEFAULT_EVIDENCE_PREFIX,
    forcePathStyle: row.forcePathStyle,
    sse: row.sse,
    kmsKeyId: row.kmsKeyId ?? null,
    retentionDays: row.retentionDays,
    maxBytesPerTask: row.maxBytesPerTask,
    status: row.status,
    lastVerifiedAt: iso(row.lastVerifiedAt),
    lastError: row.lastError ?? null,
    hasCredential: !!row.credentialSecretId,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}
