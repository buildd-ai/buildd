import { describe, it, expect, mock, beforeEach } from 'bun:test';

const TEAM = 'team-1';
const OTHER_TEAM = 'team-2';
const WS = 'ws-1';

interface Update { table: string; set: Record<string, unknown> }

const state = {
  workspace: { id: WS, teamId: TEAM } as { id: string; teamId: string } | undefined,
  backends: [] as any[],
  secrets: {} as Record<string, any>,
  updates: [] as Update[],
  failUpdates: false,
  storageConfigured: true,
};

function table(name: string) {
  return new Proxy({ __t: name } as Record<string, unknown>, {
    get: (t, p) => (p === '__t' ? t.__t : `${name}.${String(p)}`),
  });
}

const tables = {
  evidenceBackends: table('evidenceBackends'),
  secrets: table('secrets'),
  workspaces: table('workspaces'),
};

mock.module('@buildd/core/db/schema', () => tables);
mock.module('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
}));
mock.module('@buildd/core/config', () => ({
  config: { storageBucket: 'default-bucket', storageEndpoint: 'https://default.example.com', storageRegion: 'auto' },
}));
mock.module('@buildd/core/secrets', () => ({ decrypt: (v: string) => v }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: async () => state.workspace },
      evidenceBackends: {
        findMany: async () => state.backends,
        findFirst: async ({ where }: any) => state.backends.find(b => b.id === where.val),
      },
      secrets: { findFirst: async ({ where }: any) => state.secrets[where.val] },
    },
    update: (t: any) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          if (state.failUpdates) throw new Error('db down');
          state.updates.push({ table: t.__t, set });
        },
      }),
    }),
  },
}));
mock.module('./storage', () => ({
  getDefaultStorageClient: () => ({ send: async () => ({}), __default: true }),
  isStorageConfigured: () => state.storageConfigured,
}));
mock.module('./credential-health', () => ({
  recordCredentialAuthSuccess: async (id: string) => {
    state.updates.push({ table: 'secrets', set: { healthStatus: 'healthy', id } });
  },
}));

const mod = await import('./evidence-backend');

const CREDS = JSON.stringify({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'shh-secret' });

function backend(over: Record<string, unknown> = {}) {
  return {
    id: 'be-1',
    teamId: TEAM,
    workspaceId: null,
    provider: 's3_compatible',
    endpoint: 'https://s3.customer.example.com',
    region: 'us-east-1',
    bucket: 'customer-bucket',
    prefix: 'team-evidence',
    forcePathStyle: true,
    credentialSecretId: 'sec-1',
    sse: 'none',
    kmsKeyId: null,
    retentionDays: 30,
    maxBytesPerTask: 8388608,
    status: 'unverified',
    lastVerifiedAt: null,
    lastError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function secret(over: Record<string, unknown> = {}) {
  return { id: 'sec-1', teamId: TEAM, purpose: 'evidence_storage_credential', encryptedValue: CREDS, ...over };
}

const publicHost = async () => ['93.184.216.34'];

beforeEach(() => {
  state.workspace = { id: WS, teamId: TEAM };
  state.backends = [];
  state.secrets = { 'sec-1': secret() };
  state.updates = [];
  state.failUpdates = false;
  state.storageConfigured = true;
});

describe('resolveEvidenceBackend precedence', () => {
  it('prefers the workspace backend over the team backend', async () => {
    state.backends = [
      backend({ id: 'team-be', bucket: 'team-bucket' }),
      backend({ id: 'ws-be', workspaceId: WS, bucket: 'ws-bucket' }),
    ];
    const r = await mod.resolveEvidenceBackend(WS);
    expect(r.source).toBe('workspace');
    expect(r.backendId).toBe('ws-be');
    expect(r.bucket).toBe('ws-bucket');
    expect(r.usable).toBe(true);
  });

  it('falls back to the team backend when the workspace has none', async () => {
    state.backends = [backend({ id: 'team-be', bucket: 'team-bucket' })];
    const r = await mod.resolveEvidenceBackend(WS);
    expect(r.source).toBe('team');
    expect(r.bucket).toBe('team-bucket');
    expect(r.prefix).toBe('team-evidence');
  });

  it('ignores a backend scoped to another workspace', async () => {
    state.backends = [backend({ id: 'other-ws', workspaceId: 'ws-other' })];
    const r = await mod.resolveEvidenceBackend(WS);
    expect(r.source).toBe('buildd_default');
  });

  it('ignores a backend belonging to another team', async () => {
    state.backends = [backend({ id: 'foreign', teamId: OTHER_TEAM })];
    const r = await mod.resolveEvidenceBackend(WS);
    expect(r.source).toBe('buildd_default');
  });

  it('falls back to buildd_default when nothing is configured', async () => {
    const r = await mod.resolveEvidenceBackend(WS);
    expect(r.source).toBe('buildd_default');
    expect(r.provider).toBe('buildd_default');
    expect(r.bucket).toBe('default-bucket');
    expect(r.retentionDays).toBe(mod.BUILDD_DEFAULT_RETENTION_DAYS);
    expect(r.usable).toBe(true);
  });

  it('reports buildd_default as unusable when the managed bucket is not configured', async () => {
    state.storageConfigured = false;
    const r = await mod.resolveEvidenceBackend(WS);
    expect(r.usable).toBe(false);
    expect(r.problem).toBeTruthy();
  });

  it('resolves to buildd_default for a workspace that does not exist', async () => {
    state.workspace = undefined;
    const r = await mod.resolveEvidenceBackend('missing');
    expect(r.source).toBe('buildd_default');
  });

  it('marks a backend unusable when its credential belongs to another team', async () => {
    state.backends = [backend({ workspaceId: WS })];
    state.secrets = { 'sec-1': secret({ teamId: OTHER_TEAM }) };
    const r = await mod.resolveEvidenceBackend(WS);
    expect(r.usable).toBe(false);
    expect(r.source).toBe('workspace');
    expect(r.problem).toContain('different team');
  });

  it('does not fall through to another bucket when the most specific backend is unusable', async () => {
    state.backends = [
      backend({ id: 'team-be', bucket: 'team-bucket', credentialSecretId: 'sec-2' }),
      backend({ id: 'ws-be', workspaceId: WS, bucket: 'ws-bucket' }),
    ];
    state.secrets = { 'sec-1': secret({ teamId: OTHER_TEAM }), 'sec-2': secret({ id: 'sec-2' }) };
    const r = await mod.resolveEvidenceBackend(WS);
    expect(r.backendId).toBe('ws-be');
    expect(r.usable).toBe(false);
  });

  it('marks a backend unusable when its credential is missing or of the wrong purpose', async () => {
    state.backends = [backend()];
    state.secrets = {};
    expect((await mod.resolveEvidenceBackend(WS)).usable).toBe(false);
    state.secrets = { 'sec-1': secret({ purpose: 'cloudflare_token' }) };
    expect((await mod.resolveEvidenceBackend(WS)).usable).toBe(false);
    state.backends = [backend({ credentialSecretId: null })];
    expect((await mod.resolveEvidenceBackend(WS)).usable).toBe(false);
  });

  it('never carries credential material on the resolved value', async () => {
    state.backends = [backend()];
    const json = JSON.stringify(await mod.resolveEvidenceBackend(WS));
    expect(json).not.toContain('shh-secret');
    expect(json).not.toContain('AKIAEXAMPLE');
  });
});

describe('validateEvidenceEndpoint (SSRF)', () => {
  it('accepts an https endpoint that resolves to a public address', async () => {
    expect(await mod.validateEvidenceEndpoint('https://s3.example.com', publicHost)).toEqual({ ok: true });
  });

  for (const ip of ['10.0.0.5', '172.16.4.1', '192.168.1.10', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
    it(`rejects the literal address ${ip}`, async () => {
      const r = await mod.validateEvidenceEndpoint(`https://${ip}`, publicHost);
      expect(r.ok).toBe(false);
    });
  }

  for (const ip of ['[::1]', '[fe80::1]', '[fd00::1]', '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]']) {
    it(`rejects the IPv6 literal ${ip}`, async () => {
      const r = await mod.validateEvidenceEndpoint(`https://${ip}`, publicHost);
      expect(r.ok).toBe(false);
    });
  }

  it('rejects localhost and internal names without resolving them', async () => {
    let resolved = false;
    const spy = async () => { resolved = true; return ['93.184.216.34']; };
    for (const host of ['localhost', 'db.internal', 'printer.local', 'x.localhost']) {
      expect((await mod.validateEvidenceEndpoint(`https://${host}`, spy)).ok).toBe(false);
    }
    expect(resolved).toBe(false);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    const r = await mod.validateEvidenceEndpoint('https://bucket.attacker.example', async () => ['10.1.2.3']);
    expect(r.ok).toBe(false);
  });

  it('rejects a hostname when any one of its addresses is private', async () => {
    const r = await mod.validateEvidenceEndpoint('https://mixed.example', async () => ['93.184.216.34', '169.254.169.254']);
    expect(r.ok).toBe(false);
  });

  it('rejects a hostname that does not resolve', async () => {
    const r = await mod.validateEvidenceEndpoint('https://nope.example', async () => { throw new Error('ENOTFOUND'); });
    expect(r.ok).toBe(false);
  });

  it('rejects non-https, credentials in the URL, and garbage', async () => {
    expect((await mod.validateEvidenceEndpoint('http://s3.example.com', publicHost)).ok).toBe(false);
    expect((await mod.validateEvidenceEndpoint('https://user:pw@s3.example.com', publicHost)).ok).toBe(false);
    expect((await mod.validateEvidenceEndpoint('not a url', publicHost)).ok).toBe(false);
  });
});

describe('getEvidenceS3Client', () => {
  it('builds a client from the stored credential', async () => {
    const client = await mod.getEvidenceS3Client(backend() as any, { resolveHost: publicHost });
    expect(typeof client.send).toBe('function');
  });

  it('refuses an endpoint that resolves privately', async () => {
    await expect(mod.getEvidenceS3Client(backend() as any, { resolveHost: async () => ['10.0.0.1'] })).rejects.toThrow(/private/);
  });

  it('refuses a credential from another team', async () => {
    state.secrets = { 'sec-1': secret({ teamId: OTHER_TEAM }) };
    await expect(mod.getEvidenceS3Client(backend() as any, { resolveHost: publicHost })).rejects.toThrow(/different team/);
  });

  it('uses the env-configured client for buildd_default', async () => {
    const client = await mod.getEvidenceS3Client(backend({ provider: 'buildd_default' }) as any);
    expect((client as any).__default).toBe(true);
  });
});

describe('evidenceSseParams', () => {
  it('maps each mode to its S3 fields', () => {
    expect(mod.evidenceSseParams({ sse: 'none', kmsKeyId: null })).toEqual({});
    expect(mod.evidenceSseParams({ sse: 'AES256', kmsKeyId: null })).toEqual({ ServerSideEncryption: 'AES256' });
    expect(mod.evidenceSseParams({ sse: 'aws:kms', kmsKeyId: 'k1' })).toEqual({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'k1' });
  });
});

function fakeClient(opts: { failOn?: 'PutObjectCommand' | 'GetObjectCommand' | 'DeleteObjectCommand'; error?: any } = {}) {
  const calls: { name: string; input: any }[] = [];
  const objects = new Map<string, string>();
  return {
    calls,
    send: async (cmd: any) => {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      if (opts.failOn === name) throw opts.error ?? Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      if (name === 'PutObjectCommand') objects.set(cmd.input.Key, String(cmd.input.Body));
      if (name === 'GetObjectCommand') {
        const v = objects.get(cmd.input.Key) ?? '';
        return { Body: { transformToString: async () => v } };
      }
      if (name === 'DeleteObjectCommand') objects.delete(cmd.input.Key);
      return {};
    },
  };
}

const privateFetch = (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
const publicFetch = (async () => new Response('probe', { status: 200 })) as unknown as typeof fetch;

const backendUpdate = () => state.updates.find(u => u.table === 'evidenceBackends');
const secretUpdates = () => state.updates.filter(u => u.table === 'secrets');

describe('verifyEvidenceBackend', () => {
  beforeEach(() => {
    state.backends = [backend()];
  });

  it('PUTs, GETs and DELETEs one probe object under the prefix and never lists', async () => {
    const client = fakeClient();
    const r = await mod.verifyEvidenceBackend('be-1', { client: client as any, fetchImpl: privateFetch });
    expect(client.calls.map(c => c.name)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']);
    const keys = new Set(client.calls.map(c => c.input.Key));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^team-evidence\/\.buildd-probe\/[0-9a-f-]{36}$/);
    expect(client.calls.every(c => c.input.Bucket === 'customer-bucket')).toBe(true);
    expect(r.status).toBe('ok');
    expect(r.error).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it('records status ok, the timestamp, and clears the error on the row', async () => {
    const now = new Date('2026-03-01T12:00:00Z');
    await mod.verifyEvidenceBackend('be-1', { client: fakeClient() as any, fetchImpl: privateFetch, now: () => now });
    const u = backendUpdate()!;
    expect(u.set.status).toBe('ok');
    expect(u.set.lastVerifiedAt).toEqual(now);
    expect(u.set.lastError).toBeNull();
  });

  it('records the credential health columns on success', async () => {
    await mod.verifyEvidenceBackend('be-1', { client: fakeClient() as any, fetchImpl: privateFetch });
    const s = secretUpdates();
    expect(s.some(u => u.set.lastVerificationError === null && u.set.lastVerifiedAt instanceof Date)).toBe(true);
    expect(s.some(u => u.set.healthStatus === 'healthy')).toBe(true);
  });

  it('marks a failing PUT as failing without throwing', async () => {
    const client = fakeClient({ failOn: 'PutObjectCommand' });
    const r = await mod.verifyEvidenceBackend('be-1', { client: client as any, fetchImpl: privateFetch });
    expect(r.status).toBe('failing');
    expect(r.error).toContain('PUT failed');
    expect(r.error).toContain('AccessDenied');
    expect(backendUpdate()!.set.status).toBe('failing');
    expect(String(backendUpdate()!.set.lastError)).toContain('PUT failed');
    expect(client.calls.map(c => c.name)).toEqual(['PutObjectCommand']);
  });

  it('marks a failing GET as failing and still cleans up the probe object', async () => {
    const client = fakeClient({ failOn: 'GetObjectCommand' });
    const r = await mod.verifyEvidenceBackend('be-1', { client: client as any, fetchImpl: privateFetch });
    expect(r.status).toBe('failing');
    expect(client.calls.map(c => c.name)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']);
  });

  it('touches nothing but the backend row and its credential when a probe fails', async () => {
    await mod.verifyEvidenceBackend('be-1', { client: fakeClient({ failOn: 'PutObjectCommand' }) as any, fetchImpl: privateFetch });
    expect(state.updates.every(u => u.table === 'evidenceBackends' || u.table === 'secrets')).toBe(true);
  });

  it('records the failure on the credential without revoking it for an ordinary error', async () => {
    await mod.verifyEvidenceBackend('be-1', { client: fakeClient({ failOn: 'PutObjectCommand' }) as any, fetchImpl: privateFetch });
    const s = secretUpdates();
    expect(s.some(u => typeof u.set.lastVerificationError === 'string')).toBe(true);
    expect(s.some(u => u.set.healthStatus === 'revoked')).toBe(false);
  });

  it('revokes the credential when the provider rejects it', async () => {
    const error = Object.assign(new Error('The AWS Access Key Id you provided does not exist'), { name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } });
    const r = await mod.verifyEvidenceBackend('be-1', { client: fakeClient({ failOn: 'PutObjectCommand', error }) as any, fetchImpl: privateFetch });
    expect(r.status).toBe('failing');
    expect(secretUpdates().some(u => u.set.healthStatus === 'revoked')).toBe(true);
  });

  it('warns, and stays ok, when the probe object is readable without credentials', async () => {
    const r = await mod.verifyEvidenceBackend('be-1', { client: fakeClient() as any, fetchImpl: publicFetch });
    expect(r.status).toBe('ok');
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('without credentials');
    expect(String(backendUpdate()!.set.lastError)).toMatch(/^warning:/);
  });

  it('builds the anonymous probe URL from the endpoint, bucket and key', async () => {
    let seen = '';
    const fetchImpl = (async (url: string) => { seen = url; return new Response('', { status: 403 }); }) as unknown as typeof fetch;
    await mod.verifyEvidenceBackend('be-1', { client: fakeClient() as any, fetchImpl });
    expect(seen).toMatch(/^https:\/\/s3\.customer\.example\.com\/customer-bucket\/team-evidence\/\.buildd-probe\//);
  });

  it('treats a probe object that cannot be deleted as a warning, not a failure', async () => {
    const client = fakeClient({ failOn: 'DeleteObjectCommand' });
    const r = await mod.verifyEvidenceBackend('be-1', { client: client as any, fetchImpl: privateFetch });
    expect(r.status).toBe('ok');
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('could not be deleted');
  });

  it('fails when GET returns different content than was written', async () => {
    const client = fakeClient();
    const send = client.send;
    client.send = async (cmd: any) => {
      if (cmd.constructor.name === 'GetObjectCommand') return { Body: { transformToString: async () => 'something else' } };
      return send(cmd);
    };
    const r = await mod.verifyEvidenceBackend('be-1', { client: client as any, fetchImpl: privateFetch });
    expect(r.status).toBe('failing');
  });

  it('fails without calling the bucket when the endpoint resolves privately', async () => {
    const r = await mod.verifyEvidenceBackend('be-1', { resolveHost: async () => ['10.0.0.9'], fetchImpl: privateFetch });
    expect(r.status).toBe('failing');
    expect(r.error).toMatch(/private/);
    expect(backendUpdate()!.set.status).toBe('failing');
  });

  it('fails, without throwing, when the credential belongs to another team', async () => {
    state.secrets = { 'sec-1': secret({ teamId: OTHER_TEAM }) };
    const client = fakeClient();
    const r = await mod.verifyEvidenceBackend('be-1', { client: client as any, fetchImpl: privateFetch });
    expect(r.status).toBe('failing');
    expect(client.calls).toEqual([]);
  });

  it('returns failing for an unknown backend', async () => {
    const r = await mod.verifyEvidenceBackend('nope', { client: fakeClient() as any });
    expect(r.status).toBe('failing');
    expect(r.error).toBe('backend not found');
    expect(state.updates).toEqual([]);
  });

  it('does not throw when recording the result fails', async () => {
    state.failUpdates = true;
    const r = await mod.verifyEvidenceBackend('be-1', { client: fakeClient() as any, fetchImpl: privateFetch });
    expect(r.status).toBe('ok');
  });

  it('never puts credential material in the result or the stored error', async () => {
    const error = Object.assign(new Error('boom'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    const r = await mod.verifyEvidenceBackend('be-1', { client: fakeClient({ failOn: 'PutObjectCommand', error }) as any, fetchImpl: privateFetch });
    const all = JSON.stringify([r, state.updates]);
    expect(all).not.toContain('shh-secret');
    expect(all).not.toContain('AKIAEXAMPLE');
  });
});

describe('generateEvidenceUploadUrl', () => {
  const KEY = 'team-evidence/ws-1/root-1/task-1/worker-1/command_output/1700000000000-0.log.gz';

  async function resolvedByo(over: Record<string, unknown> = {}) {
    state.backends = [backend({ endpoint: null, region: 'us-east-1', ...over })];
    return mod.resolveEvidenceBackend(WS);
  }

  it('signs a 15 minute PUT for the exact key with content-length bound in', async () => {
    const url = new URL(await mod.generateEvidenceUploadUrl(await resolvedByo(), KEY, 4242));
    expect(url.pathname).toContain(`/customer-bucket/${KEY}`);
    expect(mod.EVIDENCE_UPLOAD_EXPIRY_SECONDS).toBe(900);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
  });

  it('never carries the secret access key in the URL', async () => {
    const url = await mod.generateEvidenceUploadUrl(await resolvedByo(), KEY, 10);
    expect(url).not.toContain('shh-secret');
  });

  it('signs SSE into the request when the backend asks for it', async () => {
    const url = await mod.generateEvidenceUploadUrl(await resolvedByo({ sse: 'AES256' }), KEY, 10);
    expect(url.toLowerCase()).toContain('x-amz-server-side-encryption');
  });

  it('refuses an unusable backend', async () => {
    state.secrets = {};
    await expect(mod.generateEvidenceUploadUrl(await resolvedByo(), KEY, 10)).rejects.toThrow();
  });

  it('refuses a non-positive size', async () => {
    await expect(mod.generateEvidenceUploadUrl(await resolvedByo(), KEY, 0)).rejects.toThrow();
  });
});
