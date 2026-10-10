/**
 * Settings → Storage form logic: per-provider required fields, the https rule
 * for endpoints, write-only credentials on edit, and the lifecycle snippet.
 * Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import {
  emptyForm,
  formFromBackend,
  lifecycleSnippet,
  toCreateBody,
  toUpdateBody,
  validateForm,
  type StorageBackend,
  type StorageForm,
} from './storage-form';

const BACKEND: StorageBackend = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: null,
  provider: 's3',
  endpoint: null,
  region: 'us-east-1',
  bucket: 'acme-evidence',
  prefix: 'evidence',
  forcePathStyle: false,
  sse: 'AES256',
  kmsKeyId: null,
  retentionDays: 45,
  maxBytesPerTask: 8 * 1024 * 1024,
  status: 'ok',
  lastVerifiedAt: '2026-09-30T12:00:00.000Z',
  lastError: null,
  hasCredential: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
};

const filled = (over: Partial<StorageForm> = {}): StorageForm => ({
  ...emptyForm(),
  provider: 's3',
  region: 'us-east-1',
  bucket: 'acme-evidence',
  accessKeyId: 'AKIAEXAMPLEEXAMPLE',
  secretAccessKey: 'example-secret-not-real',
  ...over,
});

describe('validateForm: required fields per provider', () => {
  it('s3 needs bucket, region and both credential halves', () => {
    const errors = validateForm({ ...emptyForm(), provider: 's3' }, 'create');
    expect(Object.keys(errors).sort()).toEqual(['accessKeyId', 'bucket', 'region', 'secretAccessKey']);
    expect(validateForm(filled(), 'create')).toEqual({});
  });

  it('r2 and s3_compatible need an endpoint; region is optional', () => {
    for (const provider of ['r2', 's3_compatible'] as const) {
      const errors = validateForm(filled({ provider, region: '' }), 'create');
      expect(Object.keys(errors)).toEqual(['endpoint']);
      expect(validateForm(filled({ provider, region: '', endpoint: 'https://example.r2.cloudflarestorage.com' }), 'create')).toEqual({});
    }
  });

  it('buildd_default needs nothing', () => {
    expect(validateForm({ ...emptyForm(), provider: 'buildd_default' }, 'create')).toEqual({});
  });

  it('rejects a bad bucket name', () => {
    expect(validateForm(filled({ bucket: 'Has_Upper' }), 'create').bucket).toBeTruthy();
  });

  it('aws:kms needs a key id', () => {
    expect(validateForm(filled({ sse: 'aws:kms' }), 'create').kmsKeyId).toBeTruthy();
    expect(validateForm(filled({ sse: 'aws:kms', kmsKeyId: 'arn:aws:kms:us-east-1:000000000000:key/example' }), 'create')).toEqual({});
  });

  it('retention is a whole number of days from 1 to 3650', () => {
    for (const bad of ['0', '3651', '1.5', 'abc', '']) {
      expect(validateForm(filled({ retentionDays: bad }), 'create').retentionDays).toBeTruthy();
    }
    expect(validateForm(filled({ retentionDays: '3650' }), 'create')).toEqual({});
  });
});

describe('validateForm: endpoint must be https', () => {
  it('refuses http and non-URLs', () => {
    expect(validateForm(filled({ provider: 'r2', endpoint: 'http://example.com' }), 'create').endpoint).toContain('https');
    expect(validateForm(filled({ provider: 'r2', endpoint: 'not a url' }), 'create').endpoint).toBeTruthy();
    expect(validateForm(filled({ endpoint: 'ftp://example.com' }), 'create').endpoint).toContain('https');
  });

  it('checks an optional s3 endpoint too', () => {
    expect(validateForm(filled({ endpoint: 'http://s3.example.com' }), 'create').endpoint).toBeTruthy();
    expect(validateForm(filled({ endpoint: 'https://s3.example.com' }), 'create')).toEqual({});
  });
});

describe('credentials are write-only', () => {
  it('formFromBackend never copies a credential, even if the DTO carried one', () => {
    const poisoned = {
      ...BACKEND,
      accessKeyId: 'AKIALEAKEDLEAKED',
      secretAccessKey: 'leaked-secret-value',
      sessionToken: 'leaked-session',
      credentials: { accessKeyId: 'AKIALEAKEDLEAKED', secretAccessKey: 'leaked-secret-value' },
    } as unknown as StorageBackend;
    const form = formFromBackend(poisoned);
    expect(form.accessKeyId).toBe('');
    expect(form.secretAccessKey).toBe('');
    expect(form.sessionToken).toBe('');
    expect(JSON.stringify(form)).not.toContain('leaked');
  });

  it('on edit, blank credential fields keep the stored one and are not sent', () => {
    const form = formFromBackend(BACKEND);
    expect(validateForm(form, 'edit')).toEqual({});
    const body = toUpdateBody(form, BACKEND);
    expect('credentials' in body).toBe(false);
  });

  it('on edit, a half-filled credential is an error', () => {
    const form = { ...formFromBackend(BACKEND), accessKeyId: 'AKIANEWNEWNEW' };
    expect(validateForm(form, 'edit').secretAccessKey).toBeTruthy();
  });

  it('on edit, a filled credential replaces the stored one', () => {
    const form = { ...formFromBackend(BACKEND), accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret', sessionToken: '' };
    expect(toUpdateBody(form, BACKEND).credentials).toEqual({ accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret' });
  });
});

describe('request bodies', () => {
  it('create sends the scope, fields and credentials, trimmed, with days as a number', () => {
    const body = toCreateBody(filled({ workspaceId: 'ws-1', bucket: ' acme-evidence ', retentionDays: '14' }));
    expect(body).toEqual({
      provider: 's3',
      workspaceId: 'ws-1',
      region: 'us-east-1',
      bucket: 'acme-evidence',
      prefix: 'evidence',
      forcePathStyle: false,
      sse: 'none',
      retentionDays: 14,
      credentials: { accessKeyId: 'AKIAEXAMPLEEXAMPLE', secretAccessKey: 'example-secret-not-real' },
    });
  });

  it('create for buildd_default sends only provider, scope and prefix', () => {
    expect(toCreateBody({ ...emptyForm(), provider: 'buildd_default' })).toEqual({ provider: 'buildd_default', prefix: 'evidence' });
  });

  it('update sends only changed fields and never provider or workspace', () => {
    const form = { ...formFromBackend(BACKEND), retentionDays: '60' };
    expect(toUpdateBody(form, BACKEND)).toEqual({ retentionDays: 60 });
  });
});

describe('lifecycleSnippet', () => {
  it('expires the prefix after exactly the retention days', () => {
    const s = lifecycleSnippet(BACKEND)!;
    const json = JSON.parse(s.config);
    expect(json.Rules[0].Expiration.Days).toBe(45);
    expect(json.Rules[0].Filter.Prefix).toBe('evidence/');
    expect(json.Rules[0].Status).toBe('Enabled');
    expect(s.command).toContain('--bucket acme-evidence');
  });

  it('gives an r2 bucket a wrangler command with the same days', () => {
    const s = lifecycleSnippet({ ...BACKEND, provider: 'r2', retentionDays: 7 })!;
    expect(s.command).toContain('wrangler r2 bucket lifecycle add acme-evidence');
    expect(s.command).toContain('--expire-days 7');
    expect(JSON.parse(s.config).Rules[0].Expiration.Days).toBe(7);
  });

  it('has nothing for the managed bucket', () => {
    expect(lifecycleSnippet({ ...BACKEND, provider: 'buildd_default' })).toBeNull();
  });
});
