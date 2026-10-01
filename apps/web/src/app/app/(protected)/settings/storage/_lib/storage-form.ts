/**
 * Settings → Storage: the form state behind adding and editing an evidence
 * backend, its validation, the request bodies for /api/evidence-backends, and
 * the lifecycle-rule snippet. Pure and client-safe: no DB, no fetch.
 *
 * Credentials are write-only. Nothing here ever reads a credential off a
 * backend; the form only knows `hasCredential`. On edit, blank credential
 * fields mean "keep the stored one" and are left out of the request.
 *
 * The server re-validates everything (lib/evidence-backend-input.ts, plus the
 * endpoint's DNS check); this is the same rules early, so a typo shows next to
 * its field instead of as a 400.
 */
import type { EvidenceBackendDTO, EvidenceProvider, EvidenceSse } from '@/lib/evidence-backend';

export type StorageBackend = EvidenceBackendDTO;
export type { EvidenceProvider, EvidenceSse };

export const PROVIDER_LABELS: Record<EvidenceProvider, string> = {
  s3: 'Amazon S3',
  r2: 'Cloudflare R2',
  s3_compatible: 'S3-compatible',
  buildd_default: 'buildd managed',
};

export const SSE_LABELS: Record<EvidenceSse, string> = {
  none: 'None',
  AES256: 'SSE-S3 (AES256)',
  'aws:kms': 'SSE-KMS',
};

export const DEFAULT_PREFIX = 'evidence';
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PREFIX_RE = /^[A-Za-z0-9._-]+$/;

export interface StorageForm {
  provider: EvidenceProvider;
  /** '' = team default. Fixed after creation. */
  workspaceId: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  sse: EvidenceSse;
  kmsKeyId: string;
  /** A string so a half-typed number stays in the field. */
  retentionDays: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export type FormErrors = Partial<Record<keyof StorageForm, string>>;

export function emptyForm(): StorageForm {
  return {
    provider: 's3',
    workspaceId: '',
    endpoint: '',
    region: '',
    bucket: '',
    prefix: DEFAULT_PREFIX,
    forcePathStyle: false,
    sse: 'none',
    kmsKeyId: '',
    retentionDays: String(DEFAULT_RETENTION_DAYS),
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
  };
}

/** Switch provider, resetting the path-style default the server would pick. */
export function withProvider(form: StorageForm, provider: EvidenceProvider): StorageForm {
  return {
    ...form,
    provider,
    forcePathStyle: provider !== 's3',
    region: provider === 'r2' && !form.region ? 'auto' : form.region,
  };
}

/**
 * The edit form for a stored backend. Credential fields always start blank:
 * the fields are picked one by one, so a credential on the DTO (there should
 * never be one) has no path into the form.
 */
export function formFromBackend(b: StorageBackend): StorageForm {
  return {
    provider: b.provider,
    workspaceId: b.workspaceId ?? '',
    endpoint: b.endpoint ?? '',
    region: b.region ?? '',
    bucket: b.provider === 'buildd_default' ? '' : b.bucket,
    prefix: b.prefix || DEFAULT_PREFIX,
    forcePathStyle: b.forcePathStyle,
    sse: b.sse,
    kmsKeyId: b.kmsKeyId ?? '',
    retentionDays: String(b.retentionDays),
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
  };
}

function endpointError(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a full URL, starting https://';
  }
  if (url.protocol !== 'https:') return 'The endpoint must use https';
  if (url.username || url.password) return 'Leave credentials out of the endpoint URL';
  return null;
}

export function validateForm(form: StorageForm, mode: 'create' | 'edit'): FormErrors {
  const errors: FormErrors = {};
  const prefix = form.prefix.trim();
  if (prefix && !PREFIX_RE.test(prefix)) errors.prefix = 'Letters, digits, dots, underscores and hyphens only, no slashes';

  if (form.provider === 'buildd_default') return errors;

  const endpoint = form.endpoint.trim();
  if (endpoint) {
    const e = endpointError(endpoint);
    if (e) errors.endpoint = e;
  } else if (form.provider === 'r2' || form.provider === 's3_compatible') {
    errors.endpoint = form.provider === 'r2'
      ? 'Required: https://<account-id>.r2.cloudflarestorage.com'
      : 'Required for an S3-compatible service';
  }

  const region = form.region.trim();
  if (form.provider === 's3' && !region) errors.region = 'Required for Amazon S3, for example us-east-1';
  else if (region && !REGION_RE.test(region)) errors.region = 'Lowercase letters, digits and hyphens';

  const bucket = form.bucket.trim();
  if (!bucket) errors.bucket = 'Required';
  else if (!BUCKET_RE.test(bucket)) errors.bucket = '3 to 63 lowercase letters, digits, dots and hyphens';

  if (form.sse === 'aws:kms' && !form.kmsKeyId.trim()) errors.kmsKeyId = 'SSE-KMS needs a key id or ARN';

  const days = form.retentionDays.trim();
  const n = Number(days);
  if (!/^\d+$/.test(days) || n < 1 || n > MAX_RETENTION_DAYS) {
    errors.retentionDays = `A whole number of days from 1 to ${MAX_RETENTION_DAYS}`;
  }

  const id = form.accessKeyId.trim();
  const secret = form.secretAccessKey.trim();
  if (mode === 'create' || id || secret || form.sessionToken.trim()) {
    if (!id) errors.accessKeyId = mode === 'create' ? 'Required' : 'Enter both halves to replace the credential';
    if (!secret) errors.secretAccessKey = mode === 'create' ? 'Required' : 'Enter both halves to replace the credential';
  }
  return errors;
}

type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

function credentialsOf(form: StorageForm): Credentials | null {
  const accessKeyId = form.accessKeyId.trim();
  const secretAccessKey = form.secretAccessKey.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = form.sessionToken.trim();
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/** POST /api/evidence-backends body. Blank optional fields are left out. */
export function toCreateBody(form: StorageForm): Record<string, unknown> {
  const body: Record<string, unknown> = { provider: form.provider };
  if (form.workspaceId) body.workspaceId = form.workspaceId;
  const prefix = form.prefix.trim() || DEFAULT_PREFIX;
  if (form.provider === 'buildd_default') {
    body.prefix = prefix;
    return body;
  }
  const endpoint = form.endpoint.trim();
  const region = form.region.trim();
  if (endpoint) body.endpoint = endpoint;
  if (region) body.region = region;
  body.bucket = form.bucket.trim();
  body.prefix = prefix;
  body.forcePathStyle = form.forcePathStyle;
  body.sse = form.sse;
  if (form.sse === 'aws:kms') body.kmsKeyId = form.kmsKeyId.trim();
  body.retentionDays = Number(form.retentionDays.trim());
  const creds = credentialsOf(form);
  if (creds) body.credentials = creds;
  return body;
}

/**
 * PATCH /api/evidence-backends/[id] body: only what changed. Provider and
 * scope are fixed at creation and never sent. Credentials go only when both
 * halves are filled in.
 */
export function toUpdateBody(form: StorageForm, current: StorageBackend): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const prefix = form.prefix.trim() || DEFAULT_PREFIX;
  if (prefix !== current.prefix) body.prefix = prefix;
  if (current.provider === 'buildd_default') return body;

  const endpoint = form.endpoint.trim();
  if (endpoint && endpoint !== (current.endpoint ?? '')) body.endpoint = endpoint;
  const region = form.region.trim();
  if (region && region !== (current.region ?? '')) body.region = region;
  const bucket = form.bucket.trim();
  if (bucket !== current.bucket) body.bucket = bucket;
  if (form.forcePathStyle !== current.forcePathStyle) body.forcePathStyle = form.forcePathStyle;
  if (form.sse !== current.sse) body.sse = form.sse;
  if (form.sse === 'aws:kms') {
    const kms = form.kmsKeyId.trim();
    if (kms !== (current.kmsKeyId ?? '') || form.sse !== current.sse) body.kmsKeyId = kms;
  }
  const days = Number(form.retentionDays.trim());
  if (days !== current.retentionDays) body.retentionDays = days;
  const creds = credentialsOf(form);
  if (creds) body.credentials = creds;
  return body;
}

export interface LifecycleSnippet {
  /** S3 lifecycle configuration JSON (R2 accepts the same API). */
  config: string;
  /** One command that applies it. */
  command: string;
}

/**
 * A bucket lifecycle rule that expires everything under the backend's prefix
 * after its retention days: the backstop for buildd's own retention job. The
 * managed bucket is buildd's to look after, so it gets none.
 */
export function lifecycleSnippet(b: Pick<StorageBackend, 'provider' | 'bucket' | 'prefix' | 'retentionDays' | 'endpoint'>): LifecycleSnippet | null {
  if (b.provider === 'buildd_default') return null;
  const prefix = `${b.prefix || DEFAULT_PREFIX}/`;
  const config = JSON.stringify({
    Rules: [{
      ID: 'buildd-evidence-expiry',
      Status: 'Enabled',
      Filter: { Prefix: prefix },
      Expiration: { Days: b.retentionDays },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    }],
  }, null, 2);
  const command = b.provider === 'r2'
    ? `npx wrangler r2 bucket lifecycle add ${b.bucket} buildd-evidence-expiry ${prefix} --expire-days ${b.retentionDays}`
    : `aws s3api put-bucket-lifecycle-configuration --bucket ${b.bucket}${b.provider === 's3_compatible' && b.endpoint ? ` --endpoint-url ${b.endpoint}` : ''} --lifecycle-configuration file://lifecycle.json`;
  return { config, command };
}

export type StatusTone = 'ok' | 'warn' | 'err' | 'idle';

export function statusChip(b: Pick<StorageBackend, 'status'>): { tone: StatusTone; label: string } {
  if (b.status === 'ok') return { tone: 'ok', label: 'Verified' };
  if (b.status === 'failing') return { tone: 'err', label: 'Failing' };
  return { tone: 'idle', label: 'Unverified' };
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${+(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${+(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
