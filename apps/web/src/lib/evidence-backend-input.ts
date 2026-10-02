/**
 * Parsing of the create/update body for /api/evidence-backends. Pure: no I/O,
 * so the endpoint's DNS check stays in the route (validateEvidenceEndpoint).
 */
import { assertSafeKeySegment } from './storage-keys';
import { parseEvidenceCredentials, type EvidenceCredentials, type EvidenceProvider, type EvidenceSse } from './evidence-backend';

const PROVIDERS: readonly EvidenceProvider[] = ['s3', 'r2', 's3_compatible', 'buildd_default'];
const SSE_MODES: readonly EvidenceSse[] = ['none', 'AES256', 'aws:kms'];

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const MIN_MAX_BYTES_PER_TASK = 64 * 1024;
export const MAX_MAX_BYTES_PER_TASK = 1024 * 1024 * 1024;
export const MAX_RETENTION_DAYS = 3650;

export interface EvidenceBackendFields {
  endpoint: string | null;
  region: string | null;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  sse: EvidenceSse;
  kmsKeyId: string | null;
  retentionDays: number;
  maxBytesPerTask: number;
}

export interface CreateEvidenceBackendInput extends EvidenceBackendFields {
  provider: EvidenceProvider;
  workspaceId: string | null;
  credentials: EvidenceCredentials | null;
}

export type UpdateEvidenceBackendInput = Partial<EvidenceBackendFields> & { credentials?: EvidenceCredentials };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A field that is absent or null is "not given"; an empty string counts as not given too. */
function given(body: Record<string, unknown>, key: string): unknown {
  const v = body[key];
  return v === undefined || v === null || v === '' ? undefined : v;
}

type FieldPatch = Partial<EvidenceBackendFields>;

function parseFields(body: Record<string, unknown>, provider: EvidenceProvider): ParseResult<FieldPatch> {
  const out: FieldPatch = {};

  const endpoint = given(body, 'endpoint');
  if (endpoint !== undefined) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) return fail('endpoint must be a URL string');
    out.endpoint = endpoint.trim();
  }

  const region = given(body, 'region');
  if (region !== undefined) {
    if (typeof region !== 'string' || !REGION_RE.test(region)) return fail('region must be lowercase letters, digits and hyphens');
    out.region = region;
  }

  const bucket = given(body, 'bucket');
  if (bucket !== undefined) {
    if (typeof bucket !== 'string' || !BUCKET_RE.test(bucket)) return fail('bucket must be a valid bucket name (3-63 lowercase letters, digits, dots, hyphens)');
    out.bucket = bucket;
  }

  const prefix = given(body, 'prefix');
  if (prefix !== undefined) {
    try {
      out.prefix = assertSafeKeySegment(prefix, 'prefix');
    } catch {
      return fail('prefix must be a single path segment of letters, digits, dots, underscores and hyphens');
    }
  }

  if (body.forcePathStyle !== undefined && body.forcePathStyle !== null) {
    if (typeof body.forcePathStyle !== 'boolean') return fail('forcePathStyle must be a boolean');
    out.forcePathStyle = body.forcePathStyle;
  }

  const sse = given(body, 'sse');
  if (sse !== undefined) {
    if (typeof sse !== 'string' || !(SSE_MODES as readonly string[]).includes(sse)) return fail('sse must be one of: none, AES256, aws:kms');
    out.sse = sse as EvidenceSse;
  }

  const kmsKeyId = given(body, 'kmsKeyId');
  if (kmsKeyId !== undefined) {
    if (typeof kmsKeyId !== 'string' || kmsKeyId.length > 2048) return fail('kmsKeyId must be a string');
    out.kmsKeyId = kmsKeyId.trim();
  }

  const retention = given(body, 'retentionDays');
  if (retention !== undefined) {
    if (typeof retention !== 'number' || !Number.isInteger(retention) || retention < 1 || retention > MAX_RETENTION_DAYS) {
      return fail(`retentionDays must be an integer from 1 to ${MAX_RETENTION_DAYS}`);
    }
    out.retentionDays = retention;
  }

  const maxBytes = given(body, 'maxBytesPerTask');
  if (maxBytes !== undefined) {
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < MIN_MAX_BYTES_PER_TASK || maxBytes > MAX_MAX_BYTES_PER_TASK) {
      return fail(`maxBytesPerTask must be an integer from ${MIN_MAX_BYTES_PER_TASK} to ${MAX_MAX_BYTES_PER_TASK}`);
    }
    out.maxBytesPerTask = maxBytes;
  }

  if (provider === 'buildd_default') {
    // The managed bucket is fixed by the deployment and keeps evidence 30 days.
    const forbidden = ['endpoint', 'region', 'bucket', 'sse', 'kmsKeyId', 'retentionDays', 'forcePathStyle'] as const;
    const set = forbidden.filter(k => out[k] !== undefined);
    if (set.length) return fail(`buildd_default takes no ${set.join(', ')}: the managed bucket is fixed`);
  }

  if (out.sse !== undefined && out.sse !== 'aws:kms' && out.kmsKeyId !== undefined) return fail('kmsKeyId is only valid with sse "aws:kms"');
  if (out.sse === 'aws:kms' && out.kmsKeyId === undefined) return fail('sse "aws:kms" requires kmsKeyId');

  return { ok: true, value: out };
}

function parseCredentialsField(body: Record<string, unknown>): ParseResult<EvidenceCredentials | undefined> {
  if (body.credentials === undefined || body.credentials === null) return { ok: true, value: undefined };
  const creds = parseEvidenceCredentials(body.credentials);
  if (!creds) return fail('credentials must be {accessKeyId, secretAccessKey, sessionToken?}');
  return { ok: true, value: creds };
}

export function parseCreateEvidenceBackend(body: unknown): ParseResult<CreateEvidenceBackendInput> {
  if (!isObject(body)) return fail('Body must be a JSON object');

  const provider = body.provider;
  if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) {
    return fail(`provider must be one of: ${PROVIDERS.join(', ')}`);
  }
  const p = provider as EvidenceProvider;

  const workspaceId = given(body, 'workspaceId');
  if (workspaceId !== undefined && typeof workspaceId !== 'string') return fail('workspaceId must be a string');

  const fields = parseFields(body, p);
  if (!fields.ok) return fields;
  const creds = parseCredentialsField(body);
  if (!creds.ok) return creds;
  const f = fields.value;

  if (p === 'buildd_default') {
    if (creds.value) return fail('buildd_default takes no credentials');
    return {
      ok: true,
      value: {
        provider: p,
        workspaceId: (workspaceId as string | undefined) ?? null,
        credentials: null,
        endpoint: null,
        region: null,
        bucket: '',
        prefix: f.prefix ?? 'evidence',
        forcePathStyle: true,
        sse: 'none',
        kmsKeyId: null,
        retentionDays: 30,
        maxBytesPerTask: f.maxBytesPerTask ?? 8 * 1024 * 1024,
      },
    };
  }

  if (f.kmsKeyId !== undefined && f.sse !== 'aws:kms') return fail('kmsKeyId is only valid with sse "aws:kms"');
  if (!f.bucket) return fail('bucket is required');
  if (!creds.value) return fail('credentials are required');
  if ((p === 'r2' || p === 's3_compatible') && !f.endpoint) return fail(`endpoint is required for provider ${p}`);

  return {
    ok: true,
    value: {
      provider: p,
      workspaceId: (workspaceId as string | undefined) ?? null,
      credentials: creds.value,
      endpoint: f.endpoint ?? null,
      region: f.region ?? null,
      bucket: f.bucket,
      prefix: f.prefix ?? 'evidence',
      forcePathStyle: f.forcePathStyle ?? p !== 's3',
      sse: f.sse ?? 'none',
      kmsKeyId: f.kmsKeyId ?? null,
      retentionDays: f.retentionDays ?? 30,
      maxBytesPerTask: f.maxBytesPerTask ?? 8 * 1024 * 1024,
    },
  };
}

/** `provider` and `workspaceId` are fixed at creation: delete and recreate to change either. */
export function parseUpdateEvidenceBackend(body: unknown, provider: EvidenceProvider, current: { sse: EvidenceSse; kmsKeyId: string | null }): ParseResult<UpdateEvidenceBackendInput> {
  if (!isObject(body)) return fail('Body must be a JSON object');
  if (body.provider !== undefined && body.provider !== provider) return fail('provider cannot be changed: delete the backend and create a new one');
  if (body.workspaceId !== undefined) return fail('workspaceId cannot be changed: delete the backend and create a new one');

  const fields = parseFields(body, provider);
  if (!fields.ok) return fields;
  const creds = parseCredentialsField(body);
  if (!creds.ok) return creds;
  if (provider === 'buildd_default' && creds.value) return fail('buildd_default takes no credentials');

  const value: UpdateEvidenceBackendInput = { ...fields.value };
  if (creds.value) value.credentials = creds.value;

  // Switching sse away from aws:kms drops the key; keeping aws:kms keeps it unless replaced.
  const sse = value.sse ?? current.sse;
  if (value.sse !== undefined && value.sse !== 'aws:kms') value.kmsKeyId = null;
  else if (sse === 'aws:kms' && value.kmsKeyId === undefined && !current.kmsKeyId) return fail('sse "aws:kms" requires kmsKeyId');
  else if (sse !== 'aws:kms' && value.kmsKeyId !== undefined) return fail('kmsKeyId is only valid with sse "aws:kms"');

  if (Object.keys(value).length === 0) return fail('No updatable fields provided');
  return { ok: true, value };
}
