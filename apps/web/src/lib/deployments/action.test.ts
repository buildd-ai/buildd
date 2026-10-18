import { describe, it, expect, mock } from 'bun:test';
import { resolveOperatorGrant } from '../operator-capability';
import { runDeploymentAction, parseDeploymentRequest, type DeploymentAuditInput, type DeploymentDeps, type DeploymentPrincipal } from './action';

const TOKEN = 'cf_secret_token_value_not_real_00000000000';
const ACCOUNT = 'fedcba9876543210fedcba9876543210';
const CRED = { apiToken: TOKEN, accountId: ACCOUNT };

const SCOPE = { providers: ['cloudflare'], projects: ['model-policy'], environments: ['production'], credentialRefs: ['cloudflare-prod'] };

function grant(opts: { roleSlug?: string; workspaceRow?: unknown; teamRow?: unknown } = {}) {
  return resolveOperatorGrant({
    roleSlug: opts.roleSlug ?? 'operator',
    workspaceId: 'ws-1',
    teamRow: (opts.teamRow ?? null) as never,
    workspaceRow: ('workspaceRow' in opts ? opts.workspaceRow : { enabled: true, metadata: { operator: { enabled: true, scope: SCOPE } } }) as never,
  });
}

function operator(g = grant()): DeploymentPrincipal {
  return { kind: 'operator', grant: g, teamId: 'team-1', accountId: 'acct-1', taskId: 'task-1', workerId: 'worker-1' };
}

const TARGET = { provider: 'cloudflare', project: 'model-policy', environment: 'production', credentialRef: 'cloudflare-prod' };

/** A Cloudflare API stand-in that records calls and answers each path. */
function cloudflare(answer: (url: string, init?: RequestInit) => { status?: number; body: unknown } = () => ({ body: { success: true, result: {} } })) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answer(url, init);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  });
  return { calls, fetchImpl };
}

function deps(over: Partial<DeploymentDeps> = {}) {
  const audits: DeploymentAuditInput[] = [];
  const settled: Array<{ id: string; outcome: string; reason: string | null; result: unknown }> = [];
  const resolveCredential = mock(async () => CRED);
  const d: DeploymentDeps = {
    recordAudit: async (row) => { audits.push(row); return `audit-${audits.length}`; },
    settleAudit: async (id, outcome, reason, result) => { settled.push({ id, outcome, reason, result }); },
    resolveCredential,
    ...over,
  };
  return { d, audits, settled, resolveCredential };
}

describe('parseDeploymentRequest', () => {
  it('lower-cases the target and rejects unknown providers and operations', () => {
    const ok = parseDeploymentRequest({ ...TARGET, project: 'Model-Policy', operation: 'status' });
    expect(ok.ok && ok.request.project).toBe('model-policy');
    expect(parseDeploymentRequest({ ...TARGET, provider: 'vercel', operation: 'status' }).ok).toBe(false);
    expect(parseDeploymentRequest({ ...TARGET, operation: 'reveal' }).ok).toBe(false);
    expect(parseDeploymentRequest({ ...TARGET, credentialRef: undefined, operation: 'status' }).ok).toBe(false);
  });
});

describe('runDeploymentAction: Operator scope', () => {
  it('runs an in-scope deploy with the server-side credential and returns no part of it', async () => {
    const { d, audits, settled } = deps();
    const cf = cloudflare(() => ({ body: { success: true, result: { etag: 'e1', modified_on: '2026-10-05T00:00:00Z', id: 'model-policy' } } }));
    const res = await runDeploymentAction(operator(), {
      ...TARGET, operation: 'upload_worker',
      params: { modules: [{ name: 'index.js', content: 'export default {}' }], compatibilityDate: '2026-09-29', compatibilityFlags: ['nodejs_compat'] },
    }, { ...d, fetchImpl: cf.fetchImpl });

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ script: 'model-policy', etag: 'e1' });
    // The provider saw the token; the caller and the audit trail did not.
    expect((cf.calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    for (const out of [res.body, audits, settled]) {
      expect(JSON.stringify(out)).not.toContain(TOKEN);
      expect(JSON.stringify(out)).not.toContain(ACCOUNT);
    }
    expect(audits[0]).toMatchObject({
      principal: 'operator', roleSlug: 'operator', taskId: 'task-1', workerId: 'worker-1', workspaceId: 'ws-1',
      provider: 'cloudflare', project: 'model-policy', environment: 'production', credentialRef: 'cloudflare-prod',
      operation: 'upload_worker', capabilities: ['deployments:write', 'deployment_secrets:use'], elevated: false, outcome: 'started',
    });
    expect(settled).toEqual([{ id: 'audit-1', outcome: 'succeeded', reason: null, result: res.body.result }]);
  });

  const outside: Array<[string, Record<string, string>, string]> = [
    ['project', { project: 'cloud-runner' }, 'project_not_allowed'],
    ['environment', { environment: 'staging' }, 'environment_not_allowed'],
    ['credential ref', { credentialRef: 'cloudflare-other' }, 'credential_ref_not_allowed'],
  ];
  for (const [dim, change, reason] of outside) {
    it(`denies a ${dim} outside scope before touching the credential or the provider`, async () => {
      const { d, audits, resolveCredential } = deps();
      const cf = cloudflare();
      const res = await runDeploymentAction(operator(), { ...TARGET, ...change, operation: 'status' }, { ...d, fetchImpl: cf.fetchImpl });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe(reason);
      expect(resolveCredential).not.toHaveBeenCalled();
      expect(cf.calls).toHaveLength(0);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ outcome: 'denied', ...change });
    });
  }

  it('denies a provider outside scope', async () => {
    const g = grant({ workspaceRow: { enabled: true, metadata: { operator: { enabled: true, scope: { ...SCOPE, providers: ['vercel'] } } } } });
    const { d, resolveCredential } = deps();
    const res = await runDeploymentAction(operator(g), { ...TARGET, operation: 'status' }, d);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('provider_not_allowed');
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('denies a workspace that has not enabled the Operator, whatever the team default says', async () => {
    const g = grant({ teamRow: { enabled: true, metadata: { operator: { enabled: true, scope: SCOPE } } }, workspaceRow: null });
    const { d, resolveCredential } = deps();
    const res = await runDeploymentAction(operator(g), { ...TARGET, operation: 'status' }, d);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('not_enabled');
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('denies a grant for a different workspace: the grant is the task workspace\'s, not the caller\'s choice', async () => {
    // The route loads the grant for the TASK's workspace; a workspace with no opt-in resolves disabled.
    const other = resolveOperatorGrant({ roleSlug: 'operator', workspaceId: 'ws-2', workspaceRow: null });
    const { d } = deps();
    const res = await runDeploymentAction(operator(other), { ...TARGET, operation: 'status' }, d);
    expect(res.status).toBe(403);
  });

  it('denies a builder task even when its row carries a full grant', async () => {
    const g = grant({ roleSlug: 'builder' });
    const { d, resolveCredential } = deps();
    const res = await runDeploymentAction(operator(g), { ...TARGET, operation: 'put_secret', params: { name: 'X', value: 'y' } }, d);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('role_not_capable');
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('a read-only grant can read status but not write', async () => {
    const g = grant({ workspaceRow: { enabled: true, metadata: { operator: { enabled: true, capabilities: ['deployments:read', 'deployment_secrets:use'], scope: SCOPE } } } });
    const { d } = deps();
    const cf = cloudflare(() => ({ body: { success: true, result: { deployments: [] } } }));
    expect((await runDeploymentAction(operator(g), { ...TARGET, operation: 'status' }, { ...d, fetchImpl: cf.fetchImpl })).status).toBe(200);
    const w = await runDeploymentAction(operator(g), { ...TARGET, operation: 'put_secret', params: { name: 'X', value: 'y' } }, d);
    expect(w.status).toBe(403);
    expect(w.body).toMatchObject({ reason: 'capability_not_granted', capability: 'deployments:write' });
  });

  it('a grant without deployment_secrets:use cannot run anything, since every operation uses the credential', async () => {
    const g = grant({ workspaceRow: { enabled: true, metadata: { operator: { enabled: true, capabilities: ['deployments:read', 'deployments:write'], scope: SCOPE } } } });
    const { d } = deps();
    const res = await runDeploymentAction(operator(g), { ...TARGET, operation: 'status' }, d);
    expect(res.body).toMatchObject({ reason: 'capability_not_granted', capability: 'deployment_secrets:use' });
  });
});

describe('runDeploymentAction: secret non-disclosure', () => {
  it('scrubs the token and account id out of a provider error', async () => {
    const { d, settled } = deps();
    const cf = cloudflare(() => ({ status: 400, body: { success: false, errors: [{ code: 10000, message: `bad token ${TOKEN} for account ${ACCOUNT}` }] } }));
    const res = await runDeploymentAction(operator(), { ...TARGET, operation: 'put_secret', params: { name: 'MODEL_POLICY', value: '{}' } }, { ...d, fetchImpl: cf.fetchImpl });
    expect(res.status).toBe(422);
    for (const out of [res.body, settled]) {
      expect(JSON.stringify(out)).not.toContain(TOKEN);
      expect(JSON.stringify(out)).not.toContain(ACCOUNT);
    }
    expect(settled[0].outcome).toBe('failed');
  });

  it('never echoes a Worker secret value it was asked to set', async () => {
    const VALUE = 'policy-token-value-that-must-not-echo';
    const { d, audits, settled } = deps();
    const cf = cloudflare(() => ({ body: { success: true, result: { name: 'POLICY_TOKENS', type: 'secret_text' } } }));
    const res = await runDeploymentAction(operator(), { ...TARGET, operation: 'put_secret', params: { name: 'POLICY_TOKENS', value: VALUE } }, { ...d, fetchImpl: cf.fetchImpl });
    expect(res.status).toBe(200);
    expect(JSON.parse(cf.calls[0].init!.body as string)).toEqual({ name: 'POLICY_TOKENS', text: VALUE, type: 'secret_text' });
    for (const out of [res.body, audits, settled]) expect(JSON.stringify(out)).not.toContain(VALUE);
  });

  it('keeps a network error (whose message can carry the URL) out of the reply', async () => {
    const { d } = deps();
    const fetchImpl = async (url: string) => { throw new Error(`connect failed ${url}`); };
    const res = await runDeploymentAction(operator(), { ...TARGET, operation: 'status' }, { ...d, fetchImpl });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(ACCOUNT);
  });

  it('status returns identity only: no author email, no annotations', async () => {
    const { d } = deps();
    const cf = cloudflare((url) => url.endsWith('/deployments')
      ? { body: { success: true, result: { deployments: [{ id: 'd1', created_on: 't', source: 'api', author_email: 'someone@example.com', annotations: { 'workers/message': 'x' }, versions: [{ version_id: 'v1', percentage: 100 }] }] } } }
      : url.endsWith('/secrets')
        ? { body: { success: true, result: [{ name: 'POLICY_TOKENS', type: 'secret_text' }] } }
        : { body: { success: true, result: { subdomain: 'acme' } } });
    const res = await runDeploymentAction(operator(), { ...TARGET, operation: 'status' }, { ...d, fetchImpl: cf.fetchImpl });
    expect(res.body.result).toEqual({
      script: 'model-policy', exists: true, deploymentCount: 1,
      latestDeployment: { id: 'd1', createdOn: 't', source: 'api', versions: [{ versionId: 'v1', percentage: 100 }] },
      secretNames: ['POLICY_TOKENS'], workersDevUrl: 'https://model-policy.acme.workers.dev',
    });
    expect(JSON.stringify(res.body)).not.toContain('someone@example.com');
  });
});

describe('runDeploymentAction: audit and credential ordering', () => {
  it('refuses to run when the audit row cannot be written, without reading the credential', async () => {
    const { d, resolveCredential } = deps({ recordAudit: async () => { throw new Error('db down'); } });
    const res = await runDeploymentAction(operator(), { ...TARGET, operation: 'status' }, d);
    expect(res.status).toBe(503);
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('404s an unknown credential reference and settles the audit row failed', async () => {
    const { d, settled } = deps({ resolveCredential: async () => null });
    const g = grant({ workspaceRow: { enabled: true, metadata: { operator: { enabled: true, scope: SCOPE } } } });
    const res = await runDeploymentAction(operator(g), { ...TARGET, operation: 'status' }, d);
    expect(res.status).toBe(404);
    expect(settled[0]).toMatchObject({ outcome: 'failed', reason: 'credential_not_found' });
  });

  it('derives the script from project and environment, so a target cannot name another Worker', async () => {
    const g = grant({ workspaceRow: { enabled: true, metadata: { operator: { enabled: true, scope: { ...SCOPE, environments: ['staging'] } } } } });
    const { d } = deps();
    const cf = cloudflare(() => ({ body: { success: true, result: { deployments: [] } } }));
    await runDeploymentAction(operator(g), { ...TARGET, environment: 'staging', operation: 'status', params: { script: 'something-else' } }, { ...d, fetchImpl: cf.fetchImpl });
    expect(cf.calls[0].url).toContain('/workers/scripts/model-policy-staging/');
  });

  it('only lets ensure_bucket name a bucket after the project\'s Worker', async () => {
    const { d } = deps();
    const bad = await runDeploymentAction(operator(), { ...TARGET, operation: 'ensure_bucket', params: { bucket: 'someone-elses-bucket' } }, d);
    expect(bad.status).toBe(400);
    const cf = cloudflare((url) => url.endsWith('/r2/buckets')
      ? { status: 409, body: { success: false, errors: [{ code: 10004, message: 'already exists' }] } }
      : { body: { success: true, result: {} } });
    const ok = await runDeploymentAction(operator(), { ...TARGET, operation: 'ensure_bucket', params: { lifecycle: [{ id: 'warm-expiry', prefix: 'warm/', expireDays: 14 }] } }, { ...d, fetchImpl: cf.fetchImpl });
    expect(ok.status).toBe(200);
    expect(ok.body.result).toEqual({ bucket: 'model-policy-snapshots', created: false, lifecycleRules: ['warm-expiry'] });
  });
});

describe('runDeploymentAction: admin escape hatch', () => {
  it('runs without a grant and is audited as admin', async () => {
    const { d, audits } = deps();
    const cf = cloudflare(() => ({ body: { success: true, result: { deployments: [] } } }));
    const res = await runDeploymentAction({ kind: 'admin', teamId: 'team-1', accountId: 'acct-9', workspaceId: 'ws-1' }, { ...TARGET, project: 'buildd-cloud-runner', operation: 'status' }, { ...d, fetchImpl: cf.fetchImpl });
    expect(res.status).toBe(200);
    expect(audits[0]).toMatchObject({ principal: 'admin', roleSlug: null, taskId: null, accountId: 'acct-9', project: 'buildd-cloud-runner' });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });
});

describe('runDeploymentAction: cloud runner release state', () => {
  const IMAGE = `docker.io/buildd/runner@sha256:${'b'.repeat(64)}`;
  const BUNDLE = {
    schema: 1, tag: 'v1.2.3', image: IMAGE, mainModule: 'index.js', modules: [{ name: 'index.js', content: 'export default {}' }],
    config: {
      name: 'buildd-cloud-runner', main: 'index.js', compatibility_date: '2026-01-01',
      containers: [{ class_name: 'Runner', image: IMAGE, instance_type: 'standard-1', max_instances: 2 }],
      durable_objects: { bindings: [{ name: 'RUNNER', class_name: 'Runner' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Runner'] }],
      r2_buckets: [{ binding: 'SNAPSHOTS', bucket_name: 'buildd-cloud-runner-snapshots' }],
    },
  };
  const LIFECYCLE = [{ id: 'warm-expiry', prefix: 'warm/', expireDays: 14 }];
  const loadRelease = async () => ({ ok: true as const, bundle: BUNDLE as never });
  const admin: DeploymentPrincipal = { kind: 'admin', teamId: 'team-1', accountId: 'acct-9', workspaceId: 'ws-1' };
  const target = { ...TARGET, project: 'buildd-cloud-runner' };

  function live(over: { release?: string | null; bucket?: boolean; maxAge?: number; image?: string } = {}) {
    return cloudflare((url) => {
      if (url.endsWith('/workers/scripts/buildd-cloud-runner/settings')) {
        const bindings = over.release === null ? [] : [{ type: 'plain_text', name: 'CLOUD_RUNNER_RELEASE', text: over.release ?? 'v1.2.3' }];
        return { body: { success: true, result: { bindings } } };
      }
      if (url.endsWith('/r2/buckets/buildd-cloud-runner-snapshots')) {
        return over.bucket === false ? { status: 404, body: { success: false, errors: [{ code: 10006, message: 'not found' }] } } : { body: { success: true, result: {} } };
      }
      if (url.endsWith('/r2/buckets/buildd-cloud-runner-snapshots/lifecycle')) {
        return { body: { success: true, result: { rules: [{ id: 'warm-expiry', enabled: true, conditions: { prefix: 'warm/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: (over.maxAge ?? 14) * 86_400 } } }] } } };
      }
      if (url.includes('/durable_objects/namespaces')) {
        return { body: { success: true, result: [{ id: 'ns-1', script: 'buildd-cloud-runner', class: 'Runner' }] } };
      }
      if (url.endsWith('/containers/applications')) {
        return { body: { success: true, result: [{ id: 'app-1', name: 'buildd-cloud-runner-runner', durable_objects: { namespace_id: 'ns-1' }, configuration: { image: over.image ?? IMAGE, instance_type: 'standard-1' }, max_instances: 2 }] } };
      }
      return { body: { success: true, result: {} } };
    });
  }

  it('reports a Worker, bucket and containers already at this release as current, and writes nothing', async () => {
    const { d } = deps();
    const cf = live();
    const res = await runDeploymentAction(admin, { ...target, operation: 'release_state', params: { release: 'v1.2.3', lifecycle: LIFECYCLE } }, { ...d, fetchImpl: cf.fetchImpl, loadRelease });
    expect(res.status).toBe(200);
    expect((res.body as any).result).toMatchObject({ worker: { current: true }, bucket: { current: true }, containers: { current: true } });
    expect(cf.calls.every((c) => (c.init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('reports each part that differs from the release as not current', async () => {
    const { d } = deps();
    const res = await runDeploymentAction(admin, { ...target, operation: 'release_state', params: { release: 'v1.2.3', lifecycle: LIFECYCLE } }, {
      ...d, fetchImpl: live({ release: 'v1.2.2', bucket: false, image: `docker.io/buildd/runner@sha256:${'c'.repeat(64)}` }).fetchImpl, loadRelease,
    });
    expect((res.body as any).result).toMatchObject({ worker: { current: false, release: 'v1.2.2' }, bucket: { current: false }, containers: { current: false } });
  });

  it('a Worker uploaded from a terminal (no release var) and a changed lifecycle are not current', async () => {
    const { d } = deps();
    const res = await runDeploymentAction(admin, { ...target, operation: 'release_state', params: { release: 'v1.2.3', lifecycle: LIFECYCLE } }, {
      ...d, fetchImpl: live({ release: null, maxAge: 7 }).fetchImpl, loadRelease,
    });
    expect((res.body as any).result).toMatchObject({ worker: { current: false, release: null }, bucket: { current: false } });
  });

  it('deploy_worker_script stamps the release on the Worker for release_state to read back', async () => {
    const { d } = deps();
    const cf = cloudflare(() => ({ body: { success: true, result: {} } }));
    const res = await runDeploymentAction(admin, { ...target, operation: 'deploy_worker_script', params: { release: 'v1.2.3' } }, { ...d, fetchImpl: cf.fetchImpl, loadRelease });
    expect(res.status).toBe(200);
    const upload = cf.calls.find((c) => c.init?.method === 'PUT' && c.url.endsWith('/workers/scripts/buildd-cloud-runner'));
    const metadata = JSON.parse(await ((upload!.init!.body as FormData).get('metadata') as Blob).text());
    expect(metadata.bindings).toContainEqual({ type: 'plain_text', name: 'CLOUD_RUNNER_RELEASE', text: 'v1.2.3' });
  });
});
