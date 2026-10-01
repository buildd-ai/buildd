import { describe, it, expect } from 'bun:test';
import { parseCreateEvidenceBackend, parseUpdateEvidenceBackend } from './evidence-backend-input';

const creds = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
const base = { provider: 's3', bucket: 'my-evidence', credentials: creds };

describe('parseCreateEvidenceBackend', () => {
  it('accepts a minimal s3 backend and applies defaults', () => {
    const r = parseCreateEvidenceBackend(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.prefix).toBe('evidence');
      expect(r.value.sse).toBe('none');
      expect(r.value.forcePathStyle).toBe(false);
      expect(r.value.workspaceId).toBeNull();
    }
  });

  it('requires credentials and a bucket for non-default providers', () => {
    expect(parseCreateEvidenceBackend({ provider: 's3', bucket: 'my-evidence' }).ok).toBe(false);
    expect(parseCreateEvidenceBackend({ provider: 's3', credentials: creds }).ok).toBe(false);
  });

  it('requires an endpoint for r2 and s3_compatible', () => {
    expect(parseCreateEvidenceBackend({ ...base, provider: 'r2' }).ok).toBe(false);
    expect(parseCreateEvidenceBackend({ ...base, provider: 's3_compatible', endpoint: 'https://s3.example.com' }).ok).toBe(true);
  });

  it('rejects an unsafe prefix, bad bucket, and unknown provider', () => {
    expect(parseCreateEvidenceBackend({ ...base, prefix: '../x' }).ok).toBe(false);
    expect(parseCreateEvidenceBackend({ ...base, prefix: 'a/b' }).ok).toBe(false);
    expect(parseCreateEvidenceBackend({ ...base, bucket: 'Bad_Bucket' }).ok).toBe(false);
    expect(parseCreateEvidenceBackend({ ...base, provider: 'gcs' }).ok).toBe(false);
  });

  it('enforces the kms rules', () => {
    expect(parseCreateEvidenceBackend({ ...base, sse: 'aws:kms' }).ok).toBe(false);
    expect(parseCreateEvidenceBackend({ ...base, sse: 'aws:kms', kmsKeyId: 'k' }).ok).toBe(true);
    expect(parseCreateEvidenceBackend({ ...base, sse: 'AES256', kmsKeyId: 'k' }).ok).toBe(false);
  });

  it('bounds retention and per-task size', () => {
    expect(parseCreateEvidenceBackend({ ...base, retentionDays: 0 }).ok).toBe(false);
    expect(parseCreateEvidenceBackend({ ...base, retentionDays: 3651 }).ok).toBe(false);
    expect(parseCreateEvidenceBackend({ ...base, maxBytesPerTask: 10 }).ok).toBe(false);
  });

  it('buildd_default takes no bucket, endpoint or credentials', () => {
    expect(parseCreateEvidenceBackend({ provider: 'buildd_default' }).ok).toBe(true);
    expect(parseCreateEvidenceBackend({ provider: 'buildd_default', bucket: 'my-evidence' }).ok).toBe(false);
    expect(parseCreateEvidenceBackend({ provider: 'buildd_default', credentials: creds }).ok).toBe(false);
    expect(parseCreateEvidenceBackend({ provider: 'buildd_default', retentionDays: 90 }).ok).toBe(false);
  });

  it('rejects a non-object body', () => {
    expect(parseCreateEvidenceBackend(null).ok).toBe(false);
    expect(parseCreateEvidenceBackend([]).ok).toBe(false);
  });
});

describe('parseUpdateEvidenceBackend', () => {
  const cur = { sse: 'none' as const, kmsKeyId: null };

  it('refuses to change provider or workspace', () => {
    expect(parseUpdateEvidenceBackend({ provider: 'r2' }, 's3', cur).ok).toBe(false);
    expect(parseUpdateEvidenceBackend({ workspaceId: 'x' }, 's3', cur).ok).toBe(false);
  });

  it('refuses an empty patch', () => {
    expect(parseUpdateEvidenceBackend({}, 's3', cur).ok).toBe(false);
  });

  it('drops the kms key when sse moves off aws:kms', () => {
    const r = parseUpdateEvidenceBackend({ sse: 'AES256' }, 's3', { sse: 'aws:kms', kmsKeyId: 'k' });
    expect(r.ok && r.value.kmsKeyId).toBeNull();
  });

  it('requires a kms key when switching to aws:kms', () => {
    expect(parseUpdateEvidenceBackend({ sse: 'aws:kms' }, 's3', cur).ok).toBe(false);
  });

  it('accepts a credential replacement alone', () => {
    const r = parseUpdateEvidenceBackend({ credentials: creds }, 's3', cur);
    expect(r.ok).toBe(true);
  });
});
