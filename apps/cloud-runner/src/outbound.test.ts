import { describe, expect, test } from 'bun:test';
import {
  CONTAINER_CREDENTIAL_HEADERS,
  DISPATCH_TOKEN_HEADER,
  GITHUB_TOKEN_FAILURE_BACKOFF_MS,
  GITHUB_TOKEN_REFRESH_MARGIN_MS,
  GithubTokenCache,
  INTERCEPTED_HOSTS,
  MODEL_ENDPOINT_FAILURE_BACKOFF_MS,
  ModelEndpointCache,
  NoModelEndpointError,
  modelEndpointRequest,
  needsServerModelEndpoint,
  parseServerModelEndpoint,
  mapEndpointModel,
  rewriteModelInBody,
  isModelRewritePath,
  endpointRejectedKey,
  type ServerModelEndpoint,
  classifyEgressHost,
  describeForwardForDebug,
  fingerprint,
  githubTokenRequest,
  parseGithubGrant,
  parseModelProxyUrl,
  resolveModelRoute,
  rewriteOutbound,
  MODEL_API_ROUTES,
  modelApiPathAllowed,
  type GithubGrant,
  type ModelRoute,
} from './outbound';

const GATEWAY_ENV = { AI_GATEWAY_ACCOUNT_ID: 'acct123', AI_GATEWAY_ID: 'gw-1', AI_GATEWAY_TOKEN: 'gw-secret-token' };
const gateway = resolveModelRoute(GATEWAY_ENV);
const NOW = 1_000_000_000_000;
const GRANT: GithubGrant = { token: 'ghs_real_installation_token', expiresAt: NOW + 60 * 60 * 1000, owner: 'acme', repo: 'widget' };

/** Every credential header a hostile or confused container could send. */
function hostileHeaders(): Record<string, string> {
  return {
    'x-api-key': 'sk-ant-container-supplied',
    authorization: 'Bearer container-supplied',
    'proxy-authorization': 'Basic container-supplied',
    'anthropic-api-key': 'container-supplied',
    'cf-aig-authorization': 'Bearer container-supplied',
    cookie: 'user_session=container-supplied',
    host: 'evil.example',
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
}

function forwarded(decision: ReturnType<typeof rewriteOutbound>) {
  if (decision.action !== 'forward') throw new Error(`expected forward, got ${decision.action}`);
  return decision;
}

function expectNoContainerCredential(headers: Headers) {
  for (const [name, value] of headers) {
    expect(value).not.toContain('container-supplied');
    expect(name).not.toBe('host');
  }
}

describe('classifyEgressHost', () => {
  test.each([
    ['api.anthropic.com', 'anthropic'],
    ['API.Anthropic.com.', 'anthropic'],
    ['github.com', 'github'],
    ['api.github.com', 'github'],
    ['uploads.github.com', 'github'],
    ['codeload.github.com', 'github'],
    ['registry.npmjs.org', 'passthrough'],
    ['anthropic.com.evil.example', 'passthrough'],
    ['github.com.evil.example', 'passthrough'],
    ['gist.github.com', 'passthrough'],
    ['buildd-snapshots.invalid', 'snapshot'],
    ['BUILDD-SNAPSHOTS.invalid.', 'snapshot'],
    ['buildd-snapshots.invalid.evil.example', 'passthrough'],
  ] as const)('%s -> %s', (host, kind) => {
    expect(classifyEgressHost(host)).toBe(kind);
  });

  test('every intercepted host is one the rewrite handles', () => {
    for (const host of INTERCEPTED_HOSTS) expect(classifyEgressHost(host)).not.toBe('passthrough');
  });

  test('SNAPSHOT_HOST_NAME mirrors snapshots.ts', async () => {
    const { SNAPSHOT_HOST } = await import('./snapshots');
    const { SNAPSHOT_HOST_NAME } = await import('./outbound');
    expect(SNAPSHOT_HOST_NAME).toBe(SNAPSHOT_HOST);
  });

  test('the snapshot host is never in the always-on list (it is intercepted only with warm repos on)', () => {
    expect(INTERCEPTED_HOSTS).not.toContain('buildd-snapshots.invalid');
  });

  test('rewriteOutbound never forwards the snapshot host anywhere', () => {
    const d = rewriteOutbound({ url: 'https://buildd-snapshots.invalid/warm', headers: {} }, { model: gateway });
    expect(d.action).toBe('reject');
  });
});

describe('resolveModelRoute', () => {
  test('gateway when all three are set', () => {
    expect(gateway).toEqual({ kind: 'gateway', baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct123/gw-1/anthropic', token: 'gw-secret-token' });
  });

  test('unconfigured when any gateway setting is missing', () => {
    expect(resolveModelRoute({ AI_GATEWAY_ACCOUNT_ID: 'a', AI_GATEWAY_ID: 'g' }).kind).toBe('unconfigured');
    expect(resolveModelRoute({}).kind).toBe('unconfigured');
  });

  test('refuses gateway ids that would change the URL path', () => {
    expect(resolveModelRoute({ ...GATEWAY_ENV, AI_GATEWAY_ID: '../other' }).kind).toBe('unconfigured');
  });

  test('direct needs BOTH the opt-in var and the key', () => {
    expect(resolveModelRoute({ ANTHROPIC_DIRECT_API_KEY: 'sk-ant-dev' }).kind).toBe('unconfigured');
    expect(resolveModelRoute({ ALLOW_DIRECT_ANTHROPIC: '1' }).kind).toBe('unconfigured');
    expect(resolveModelRoute({ ALLOW_DIRECT_ANTHROPIC: 'true', ANTHROPIC_DIRECT_API_KEY: 'sk-ant-dev' }).kind).toBe('unconfigured');
    expect(resolveModelRoute({ ALLOW_DIRECT_ANTHROPIC: '1', ANTHROPIC_DIRECT_API_KEY: 'sk-ant-dev' })).toEqual({ kind: 'direct', apiKey: 'sk-ant-dev' });
  });

  test('a stray direct key does not override the gateway', () => {
    expect(resolveModelRoute({ ...GATEWAY_ENV, ANTHROPIC_DIRECT_API_KEY: 'sk-ant-dev' }).kind).toBe('gateway');
  });
});

const PROXY_ENV = { MODEL_PROXY_URL: 'https://litellm.example.com', MODEL_PROXY_KEY: 'proxy-secret-key' };

describe('parseModelProxyUrl', () => {
  test.each([
    ['https://litellm.example.com', 'https://litellm.example.com'],
    ['https://litellm.example.com/', 'https://litellm.example.com'],
    ['https://litellm.example.com/anthropic', 'https://litellm.example.com/anthropic'],
    ['https://litellm.example.com/anthropic//', 'https://litellm.example.com/anthropic'],
    ['https://LiteLLM.example.com:8443/x', 'https://litellm.example.com:8443/x'],
    ['http://localhost:4000', 'http://localhost:4000'],
    ['http://127.0.0.1:4000/anthropic', 'http://127.0.0.1:4000/anthropic'],
    ['http://host.docker.internal:4000', 'http://host.docker.internal:4000'],
  ])('accepts %s -> %s', (raw, base) => {
    expect(parseModelProxyUrl(raw)).toEqual({ ok: true, baseUrl: base });
  });

  test.each([
    ['not a url'],
    ['http://litellm.example.com'],
    ['http://localhost.example.com'],
    ['ftp://litellm.example.com'],
    ['https://user:pass@litellm.example.com'],
    ['https://user@litellm.example.com'],
    ['https://litellm.example.com/?team=a'],
    ['https://litellm.example.com/?'],
    ['https://litellm.example.com/#frag'],
    ['https://litellm.example.com/#'],
  ])('rejects %s', (raw) => {
    expect(parseModelProxyUrl(raw).ok).toBe(false);
  });
});

describe('resolveModelRoute: proxy', () => {
  test('proxy when MODEL_PROXY_URL and MODEL_PROXY_KEY are set; authorization is the default header', () => {
    expect(resolveModelRoute(PROXY_ENV)).toEqual({
      kind: 'proxy', baseUrl: 'https://litellm.example.com', key: 'proxy-secret-key', authHeader: 'authorization',
    });
  });

  test('MODEL_PROXY_AUTH_HEADER=x-api-key is honoured (case and whitespace tolerated)', () => {
    expect(resolveModelRoute({ ...PROXY_ENV, MODEL_PROXY_AUTH_HEADER: 'x-api-key' })).toMatchObject({ kind: 'proxy', authHeader: 'x-api-key' });
    expect(resolveModelRoute({ ...PROXY_ENV, MODEL_PROXY_AUTH_HEADER: ' X-Api-Key ' })).toMatchObject({ kind: 'proxy', authHeader: 'x-api-key' });
    expect(resolveModelRoute({ ...PROXY_ENV, MODEL_PROXY_AUTH_HEADER: 'Authorization' })).toMatchObject({ kind: 'proxy', authHeader: 'authorization' });
  });

  test('an unknown MODEL_PROXY_AUTH_HEADER is refused, not guessed', () => {
    const r = resolveModelRoute({ ...PROXY_ENV, MODEL_PROXY_AUTH_HEADER: 'cookie' });
    expect(r.kind).toBe('unconfigured');
    if (r.kind === 'unconfigured') expect(r.reason).toContain('MODEL_PROXY_AUTH_HEADER');
  });

  test('MODEL_PROXY_URL without MODEL_PROXY_KEY is unconfigured, even with a working gateway', () => {
    const r = resolveModelRoute({ ...GATEWAY_ENV, MODEL_PROXY_URL: 'https://litellm.example.com' });
    expect(r.kind).toBe('unconfigured');
    if (r.kind === 'unconfigured') expect(r.reason).toContain('MODEL_PROXY_KEY');
  });

  test('an invalid MODEL_PROXY_URL is unconfigured, never a silent fall back to the gateway', () => {
    const r = resolveModelRoute({ ...GATEWAY_ENV, MODEL_PROXY_URL: 'http://litellm.example.com', MODEL_PROXY_KEY: 'k' });
    expect(r.kind).toBe('unconfigured');
    if (r.kind === 'unconfigured') expect(r.reason).toContain('MODEL_PROXY_URL');
  });

  test('a key alone (no URL) changes nothing', () => {
    expect(resolveModelRoute({ ...GATEWAY_ENV, MODEL_PROXY_KEY: 'k' }).kind).toBe('gateway');
    expect(resolveModelRoute({ MODEL_PROXY_KEY: 'k' }).kind).toBe('unconfigured');
  });

  test('an empty MODEL_PROXY_URL counts as unset', () => {
    expect(resolveModelRoute({ ...GATEWAY_ENV, MODEL_PROXY_URL: '', MODEL_PROXY_KEY: 'k' }).kind).toBe('gateway');
  });

  test('precedence: direct > proxy > gateway', () => {
    const direct = { ALLOW_DIRECT_ANTHROPIC: '1', ANTHROPIC_DIRECT_API_KEY: 'sk-ant-dev' };
    expect(resolveModelRoute({ ...GATEWAY_ENV, ...PROXY_ENV, ...direct }).kind).toBe('direct');
    expect(resolveModelRoute({ ...GATEWAY_ENV, ...PROXY_ENV }).kind).toBe('proxy');
    expect(resolveModelRoute({ ...GATEWAY_ENV }).kind).toBe('gateway');
  });

  test('the error message never contains the key', () => {
    const r = resolveModelRoute({ MODEL_PROXY_URL: 'nope', MODEL_PROXY_KEY: 'proxy-secret-key' });
    expect(JSON.stringify(r)).not.toContain('proxy-secret-key');
  });
});

describe('rewriteOutbound: api.anthropic.com', () => {
  test('rewrites to AI Gateway, keeps path and query, sets only the gateway credential', () => {
    const d = forwarded(rewriteOutbound(
      { url: 'https://api.anthropic.com/v1/messages?beta=true', method: 'POST', headers: hostileHeaders() },
      { model: gateway },
    ));
    expect(d.url).toBe('https://gateway.ai.cloudflare.com/v1/acct123/gw-1/anthropic/v1/messages?beta=true');
    expect(d.injected).toBe('gateway');
    expect(d.headers.get('cf-aig-authorization')).toBe('Bearer gw-secret-token');
    expect(d.headers.get('x-api-key')).toBeNull();
    expect(d.headers.get('authorization')).toBeNull();
    expect(d.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(d.headers.get('content-type')).toBe('application/json');
    expectNoContainerCredential(d.headers);
  });

  test('direct mode forwards to Anthropic with the Worker key, never the container one', () => {
    const d = forwarded(rewriteOutbound(
      { url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: hostileHeaders() },
      { model: { kind: 'direct', apiKey: 'sk-ant-worker-held' } },
    ));
    expect(d.url).toBe('https://api.anthropic.com/v1/messages');
    expect(d.headers.get('x-api-key')).toBe('sk-ant-worker-held');
    expect(d.headers.get('authorization')).toBeNull();
    expect(d.headers.get('cf-aig-authorization')).toBeNull();
    expectNoContainerCredential(d.headers);
  });

  test('proxy mode: appends path and query, sends Authorization: Bearer <proxy key> only', () => {
    const d = forwarded(rewriteOutbound(
      { url: 'https://api.anthropic.com/v1/messages?beta=true', method: 'POST', headers: hostileHeaders() },
      { model: resolveModelRoute(PROXY_ENV) },
    ));
    expect(d.url).toBe('https://litellm.example.com/v1/messages?beta=true');
    expect(d.injected).toBe('proxy');
    expect(d.headers.get('authorization')).toBe('Bearer proxy-secret-key');
    expect(d.headers.get('x-api-key')).toBeNull();
    expect(d.headers.get('cf-aig-authorization')).toBeNull();
    expect(d.headers.get('anthropic-version')).toBe('2023-06-01');
    expectNoContainerCredential(d.headers);
  });

  test('proxy mode with x-api-key sends the raw key and no authorization', () => {
    const d = forwarded(rewriteOutbound(
      { url: 'https://api.anthropic.com/v1/messages/count_tokens', method: 'POST', headers: hostileHeaders() },
      { model: resolveModelRoute({ ...PROXY_ENV, MODEL_PROXY_URL: 'https://litellm.example.com/anthropic/', MODEL_PROXY_AUTH_HEADER: 'x-api-key' }) },
    ));
    expect(d.url).toBe('https://litellm.example.com/anthropic/v1/messages/count_tokens');
    expect(d.headers.get('x-api-key')).toBe('proxy-secret-key');
    expect(d.headers.get('authorization')).toBeNull();
    expectNoContainerCredential(d.headers);
  });

  test('proxy mode: plaintext and odd ports to api.anthropic.com are still refused', () => {
    const model = resolveModelRoute(PROXY_ENV);
    expect(rewriteOutbound({ url: 'http://api.anthropic.com/v1/messages', method: 'POST', headers: {} }, { model }).action).toBe('reject');
    expect(rewriteOutbound({ url: 'https://api.anthropic.com:8443/v1/messages', method: 'POST', headers: {} }, { model }).action).toBe('reject');
  });

  test('proxy mode: URL userinfo from the container does not reach the proxy', () => {
    const d = forwarded(rewriteOutbound(
      { url: 'https://user:container-supplied@api.anthropic.com/v1/messages', method: 'POST', headers: {} },
      { model: resolveModelRoute(PROXY_ENV) },
    ));
    expect(d.url).toBe('https://litellm.example.com/v1/messages');
  });

  test('proxy configured without a key is refused with 503', () => {
    const d = rewriteOutbound(
      { url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: hostileHeaders() },
      { model: resolveModelRoute({ MODEL_PROXY_URL: 'https://litellm.example.com' }) },
    );
    expect(d.action).toBe('reject');
    if (d.action === 'reject') {
      expect(d.status).toBe(503);
      expect(d.message).toContain('MODEL_PROXY_KEY');
    }
  });

  test('unconfigured is refused, not forwarded with the placeholder', () => {
    const d = rewriteOutbound(
      { url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: hostileHeaders() },
      { model: resolveModelRoute({}) },
    );
    expect(d.action).toBe('reject');
    if (d.action === 'reject') expect(d.status).toBe(503);
  });

  test('plaintext and odd ports are refused', () => {
    expect(rewriteOutbound({ url: 'http://api.anthropic.com/v1/messages', method: 'POST', headers: {} }, { model: gateway }).action).toBe('reject');
    expect(rewriteOutbound({ url: 'https://api.anthropic.com:8443/v1/messages', method: 'POST', headers: {} }, { model: gateway }).action).toBe('reject');
  });

  test('URL userinfo from the container is dropped', () => {
    const d = forwarded(rewriteOutbound(
      { url: 'https://user:container-supplied@api.anthropic.com/v1/messages', method: 'POST', headers: {} },
      { model: { kind: 'direct', apiKey: 'k' } },
    ));
    expect(d.url).not.toContain('container-supplied');
  });
});

describe('rewriteOutbound: GitHub', () => {
  const ctx = { model: gateway, github: GRANT, now: NOW };
  const basic = `Basic ${btoa(`x-access-token:${GRANT.token}`)}`;

  test.each([
    'https://github.com/acme/widget.git/info/refs?service=git-upload-pack',
    'https://github.com/acme/widget.git/git-receive-pack',
    'https://github.com/ACME/Widget/info/refs?service=git-upload-pack',
    'https://github.com/acme/widget',
  ])('git over https to the task repo gets Basic x-access-token: %s', (url) => {
    const d = forwarded(rewriteOutbound({ url, headers: hostileHeaders() }, ctx));
    expect(d.headers.get('authorization')).toBe(basic);
    expect(d.injected).toBe('github_basic');
    expectNoContainerCredential(d.headers);
  });

  test.each([
    'https://api.github.com/repos/acme/widget/pulls',
    'https://api.github.com/repos/acme/widget',
    'https://api.github.com/graphql',
    'https://uploads.github.com/repos/acme/widget/releases/1/assets',
  ])('REST/GraphQL for the task repo gets Bearer: %s', (url) => {
    const d = forwarded(rewriteOutbound({ url, headers: hostileHeaders() }, ctx));
    expect(d.headers.get('authorization')).toBe(`Bearer ${GRANT.token}`);
    expectNoContainerCredential(d.headers);
  });

  test.each([
    'https://github.com/acme/other.git/info/refs',
    'https://github.com/other/widget.git/info/refs',
    'https://github.com/acme/widget-fork.git/info/refs',
    'https://github.com/acme',
    'https://api.github.com/repos/acme/other/pulls',
    'https://api.github.com/repos/acmex/widget',
    'https://api.github.com/user',
    'https://api.github.com/search/code?q=x',
    'https://uploads.github.com/repos/other/widget/releases/1/assets',
    'https://codeload.github.com/acme/widget/tar.gz/main',
  ])('outside the task repo: container auth stripped, nothing added: %s', (url) => {
    const d = forwarded(rewriteOutbound({ url, headers: hostileHeaders() }, ctx));
    expect(d.headers.get('authorization')).toBeNull();
    expect(d.injected).toBe('none');
    expectNoContainerCredential(d.headers);
  });

  test('no grant: forwarded unauthenticated, container auth still stripped', () => {
    const d = forwarded(rewriteOutbound(
      { url: 'https://github.com/acme/widget.git/info/refs', headers: hostileHeaders() },
      { model: gateway, github: null, now: NOW },
    ));
    expect(d.headers.get('authorization')).toBeNull();
    expectNoContainerCredential(d.headers);
  });

  test('an expired grant is not attached', () => {
    const d = forwarded(rewriteOutbound(
      { url: 'https://github.com/acme/widget.git/info/refs', headers: {} },
      { model: gateway, github: { ...GRANT, expiresAt: NOW - 1 }, now: NOW },
    ));
    expect(d.headers.get('authorization')).toBeNull();
  });

  test('plaintext GitHub is refused', () => {
    expect(rewriteOutbound({ url: 'http://github.com/acme/widget.git/info/refs', headers: {} }, ctx).action).toBe('reject');
  });
});

describe('rewriteOutbound: everything else', () => {
  test('passes through untouched (the handler forwards the original request)', () => {
    expect(rewriteOutbound({ url: 'https://registry.npmjs.org/left-pad', headers: hostileHeaders() }, { model: gateway }).action).toBe('passthrough');
    expect(rewriteOutbound({ url: 'https://api.anthropic.com.evil.example/', headers: hostileHeaders() }, { model: gateway }).action).toBe('passthrough');
  });
});

describe('security: container-supplied credentials never reach a credentialed host', () => {
  // Every intercepted host, every model route, with and without a grant: the
  // forwarded request carries no header value the container supplied.
  const routes: ModelRoute[] = [
    gateway,
    { kind: 'direct', apiKey: 'sk-ant-worker-held' },
    resolveModelRoute(PROXY_ENV),
    resolveModelRoute({ ...PROXY_ENV, MODEL_PROXY_AUTH_HEADER: 'x-api-key' }),
  ];
  const urls = [
    'https://api.anthropic.com/v1/messages',
    'https://github.com/acme/widget.git/git-upload-pack',
    'https://github.com/other/repo.git/git-upload-pack',
    'https://api.github.com/repos/acme/widget',
    'https://api.github.com/graphql',
    'https://api.github.com/user',
    'https://uploads.github.com/repos/acme/widget/x',
    'https://codeload.github.com/acme/widget/zip/main',
  ];
  for (const model of routes) {
    for (const github of [GRANT, null]) {
      for (const url of urls) {
        test(`${model.kind}${model.kind === 'proxy' ? `(${model.authHeader})` : ''} ${github ? 'grant' : 'no grant'} ${url}`, () => {
          const d = forwarded(rewriteOutbound({ url, method: 'POST', headers: hostileHeaders() }, { model, github, now: NOW }));
          expectNoContainerCredential(d.headers);
          for (const name of CONTAINER_CREDENTIAL_HEADERS) {
            const v = d.headers.get(name);
            if (v !== null) expect(v).not.toContain('container-supplied');
          }
        });
      }
    }
  }
});

describe('GithubTokenCache', () => {
  function setup(fetchGrant: () => Promise<GithubGrant>) {
    let now = NOW;
    let calls = 0;
    const cache = new GithubTokenCache({
      fetchGrant: () => { calls++; return fetchGrant(); },
      now: () => now,
    });
    return { cache, calls: () => calls, advance: (ms: number) => { now += ms; } };
  }

  test('fetches once and reuses until near expiry, then refetches', async () => {
    const s = setup(async () => ({ ...GRANT, expiresAt: NOW + 60 * 60 * 1000 }));
    expect((await s.cache.get())?.token).toBe(GRANT.token);
    await s.cache.get();
    expect(s.calls()).toBe(1);
    s.advance(60 * 60 * 1000 - GITHUB_TOKEN_REFRESH_MARGIN_MS + 1);
    await s.cache.get();
    expect(s.calls()).toBe(2);
  });

  test('concurrent callers share one fetch', async () => {
    let resolve!: (g: GithubGrant) => void;
    const s = setup(() => new Promise(r => { resolve = r; }));
    const a = s.cache.get();
    const b = s.cache.get();
    resolve(GRANT);
    expect(await a).toEqual(GRANT);
    expect(await b).toEqual(GRANT);
    expect(s.calls()).toBe(1);
  });

  test('a failure yields null and backs off', async () => {
    const s = setup(async () => { throw new Error('409 no active worker'); });
    expect(await s.cache.get()).toBeNull();
    expect(await s.cache.get()).toBeNull();
    expect(s.calls()).toBe(1);
    s.advance(GITHUB_TOKEN_FAILURE_BACKOFF_MS);
    await s.cache.get();
    expect(s.calls()).toBe(2);
  });

  test('reset drops the token and an in-flight fetch from the previous run', async () => {
    let resolve!: (g: GithubGrant) => void;
    const s = setup(() => new Promise(r => { resolve = r; }));
    const stale = s.cache.get();
    s.cache.reset();
    resolve(GRANT);
    expect(await stale).toBeNull();
  });
});

describe('parseGithubGrant', () => {
  test('parses the endpoint response', () => {
    expect(parseGithubGrant({
      token: 'ghs_x', expiresAt: new Date(NOW).toISOString(),
      repository: { owner: 'acme', name: 'widget', fullName: 'acme/widget' },
    })).toEqual({ token: 'ghs_x', expiresAt: NOW, owner: 'acme', repo: 'widget' });
  });

  test('keeps the workspace id buildd returns, and drops one that is not an id', () => {
    const base = { token: 'ghs_x', expiresAt: new Date(NOW).toISOString(), repository: { owner: 'acme', name: 'widget' } };
    expect(parseGithubGrant({ ...base, workspaceId: 'ws-123' }).workspaceId).toBe('ws-123');
    expect(parseGithubGrant({ ...base, workspaceId: '../ws' }).workspaceId).toBeUndefined();
    expect(parseGithubGrant({ ...base, workspaceId: 7 }).workspaceId).toBeUndefined();
    expect('workspaceId' in parseGithubGrant(base)).toBe(false);
  });

  test.each([
    [null],
    [{}],
    [{ token: 'x', expiresAt: 'nope', repository: { owner: 'a', name: 'b' } }],
    [{ token: 'x', expiresAt: new Date(NOW).toISOString() }],
    [{ token: '', expiresAt: new Date(NOW).toISOString(), repository: { owner: 'a', name: 'b' } }],
  ])('rejects %p', (body) => {
    expect(() => parseGithubGrant(body)).toThrow();
  });
});

describe('githubTokenRequest', () => {
  test('sends the API key and the dispatch token, and the task/worker ids', () => {
    const { url, init } = githubTokenRequest(
      { BUILDD_SERVER: 'https://buildd.example/', BUILDD_API_KEY: 'bld_k', DISPATCH_TOKEN: 'dt' }, 't-1', 'w-1');
    expect(url).toBe('https://buildd.example/api/runner/github-token');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer bld_k');
    expect(h[DISPATCH_TOKEN_HEADER]).toBe('dt');
    expect(JSON.parse(init.body as string)).toEqual({ taskId: 't-1', workerId: 'w-1' });
  });

  test('refuses without the dispatch token (the container has the API key, never this)', () => {
    expect(() => githubTokenRequest({ BUILDD_SERVER: 's', BUILDD_API_KEY: 'k' }, 't')).toThrow(/DISPATCH_TOKEN/);
  });
});

describe('describeForwardForDebug', () => {
  test('fingerprints every header value and never prints one', async () => {
    const d = forwarded(rewriteOutbound(
      { url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: hostileHeaders() },
      { model: gateway },
    ));
    const echo = await describeForwardForDebug(d);
    expect(echo.url).toBe('https://gateway.ai.cloudflare.com/v1/acct123/gw-1/anthropic/v1/messages');
    expect(echo.headers['cf-aig-authorization']).toBe(await fingerprint('Bearer gw-secret-token'));
    expect(echo.headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(echo)).not.toContain('gw-secret-token');
    expect(JSON.stringify(echo)).not.toContain('container-supplied');
  });

  test('proxy mode: fingerprints the proxy credential', async () => {
    const d = forwarded(rewriteOutbound(
      { url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: hostileHeaders() },
      { model: resolveModelRoute(PROXY_ENV) },
    ));
    const echo = await describeForwardForDebug(d);
    expect(echo).toMatchObject({ url: 'https://litellm.example.com/v1/messages', injected: 'proxy' });
    expect(echo.headers.authorization).toBe(await fingerprint('Bearer proxy-secret-key'));
    expect(JSON.stringify(echo)).not.toContain('proxy-secret-key');
  });
});


// ── Server model endpoint (docs/design/agent-model-endpoint.md §3) ────────────

const SERVER: ServerModelEndpoint = { baseUrl: 'https://litellm.example.com', key: 'sk-team-endpoint', authHeader: 'authorization' };
const PROXY = { MODEL_PROXY_URL: 'https://litellm.example.com/override', MODEL_PROXY_KEY: 'proxy-secret-key' };
const DIRECT = { ALLOW_DIRECT_ANTHROPIC: '1', ANTHROPIC_DIRECT_API_KEY: 'sk-ant-dev' };

describe('resolveModelRoute: server endpoint precedence', () => {
  test('direct > Worker MODEL_PROXY_URL > server endpoint > AI Gateway > refuse', () => {
    expect(resolveModelRoute({ ...GATEWAY_ENV, ...PROXY, ...DIRECT }, SERVER).kind).toBe('direct');
    expect(resolveModelRoute({ ...GATEWAY_ENV, ...PROXY }, SERVER)).toMatchObject({ kind: 'proxy', baseUrl: 'https://litellm.example.com/override', key: 'proxy-secret-key' });
    expect(resolveModelRoute({ ...GATEWAY_ENV }, SERVER)).toEqual({ kind: 'proxy', baseUrl: SERVER.baseUrl, key: SERVER.key, authHeader: 'authorization' });
    expect(resolveModelRoute({}, SERVER)).toEqual({ kind: 'proxy', baseUrl: SERVER.baseUrl, key: SERVER.key, authHeader: 'authorization' });
    expect(resolveModelRoute({ ...GATEWAY_ENV }, null).kind).toBe('gateway');
    expect(resolveModelRoute({}, null).kind).toBe('unconfigured');
  });

  test('the x-api-key header choice is kept', () => {
    expect(resolveModelRoute({}, { ...SERVER, authHeader: 'x-api-key' })).toMatchObject({ kind: 'proxy', authHeader: 'x-api-key' });
  });

  test("'unavailable' refuses rather than silently spending on the gateway", () => {
    const r = resolveModelRoute({ ...GATEWAY_ENV }, 'unavailable');
    expect(r.kind).toBe('unconfigured');
    // ...but never overrides the operator override or the local direct route.
    expect(resolveModelRoute({ ...PROXY }, 'unavailable').kind).toBe('proxy');
    expect(resolveModelRoute({ ...DIRECT }, 'unavailable').kind).toBe('direct');
  });

  test('default no-op: omitted and null are byte-identical to the pre-endpoint result', () => {
    const envs = [
      {}, GATEWAY_ENV, PROXY, DIRECT, { ...GATEWAY_ENV, ...PROXY }, { ...GATEWAY_ENV, ...PROXY, ...DIRECT },
      { ...PROXY, MODEL_PROXY_AUTH_HEADER: 'x-api-key' }, { ...PROXY, MODEL_PROXY_AUTH_HEADER: 'cookie' },
      { MODEL_PROXY_URL: 'nope', MODEL_PROXY_KEY: 'k' }, { MODEL_PROXY_URL: 'https://litellm.example.com' },
      { ...GATEWAY_ENV, AI_GATEWAY_ID: '../x' }, { ANTHROPIC_DIRECT_API_KEY: 'sk' }, { ALLOW_DIRECT_ANTHROPIC: '1' },
    ];
    for (const env of envs) {
      expect(resolveModelRoute(env, null)).toEqual(resolveModelRoute(env));
      expect(resolveModelRoute(env, undefined)).toEqual(resolveModelRoute(env));
    }
  });

  test('a server-endpoint route strips container credentials and sets only its own header', () => {
    const d = rewriteOutbound(
      { url: 'https://api.anthropic.com/v1/messages?beta=true', method: 'POST', headers: hostileHeaders() },
      { model: resolveModelRoute({}, SERVER) },
    );
    expect(d.action).toBe('forward');
    if (d.action !== 'forward') return;
    expect(d.url).toBe('https://litellm.example.com/v1/messages?beta=true');
    expect(d.headers.get('authorization')).toBe('Bearer sk-team-endpoint');
    expect(d.headers.get('x-api-key')).toBeNull();
  });
});

describe('needsServerModelEndpoint', () => {
  test('false when direct or MODEL_PROXY_URL wins, true otherwise', () => {
    expect(needsServerModelEndpoint({})).toBe(true);
    expect(needsServerModelEndpoint(GATEWAY_ENV)).toBe(true);
    expect(needsServerModelEndpoint({ ANTHROPIC_DIRECT_API_KEY: 'sk' })).toBe(true);
    expect(needsServerModelEndpoint(PROXY)).toBe(false);
    expect(needsServerModelEndpoint(DIRECT)).toBe(false);
  });
});

describe('parseServerModelEndpoint', () => {
  test('accepts the route shape and defaults the header', () => {
    expect(parseServerModelEndpoint({ kind: 'gateway', baseUrl: 'https://litellm.example.com/', key: 'k', authHeader: 'authorization', models: {} }))
      .toEqual({ baseUrl: 'https://litellm.example.com', key: 'k', authHeader: 'authorization', kind: 'gateway', models: {} });
    expect(parseServerModelEndpoint({ baseUrl: 'https://litellm.example.com', key: 'k' }).authHeader).toBe('authorization');
  });
  test('keeps the model mapping and kind, dropping anything that is not a string-to-string pair', () => {
    const e = parseServerModelEndpoint({ kind: 'url', baseUrl: 'https://litellm.example.com', key: 'k',
      models: { 'claude-haiku-4-5-20251001': 'claude-haiku-4-5', bad: 5, '': 'x', ok: '' } });
    expect(e.kind).toBe('url');
    expect(e.models).toEqual({ 'claude-haiku-4-5-20251001': 'claude-haiku-4-5' });
    expect(parseServerModelEndpoint({ baseUrl: 'https://litellm.example.com', key: 'k', models: 'nope' }).models).toEqual({});
  });
  test('throws on anything unexpected', () => {
    for (const b of [null, {}, { baseUrl: 'http://litellm.example.com', key: 'k' }, { baseUrl: 'https://u:p@litellm.example.com', key: 'k' },
      { baseUrl: 'https://litellm.example.com', key: '' }, { baseUrl: 'https://litellm.example.com', key: 'k', authHeader: 'cookie' },
      { baseUrl: 'https://litellm.example.com', key: 'k', authHeader: 5 }]) {
      expect(() => parseServerModelEndpoint(b)).toThrow();
    }
  });
});

describe('modelEndpointRequest', () => {
  test('carries both credentials, the task and the worker', () => {
    const { url, init } = modelEndpointRequest({ BUILDD_SERVER: 'https://buildd.example/', BUILDD_API_KEY: 'bld_x', DISPATCH_TOKEN: 'd' }, 'task-1', 'worker-1');
    expect(url).toBe('https://buildd.example/api/runner/model-endpoint');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer bld_x');
    expect(h[DISPATCH_TOKEN_HEADER]).toBe('d');
    expect(JSON.parse(String(init.body))).toEqual({ taskId: 'task-1', workerId: 'worker-1' });
  });
  test('refuses without the dispatch token', () => {
    expect(() => modelEndpointRequest({ BUILDD_SERVER: 'https://buildd.example', BUILDD_API_KEY: 'bld_x' }, 't')).toThrow();
  });
});

describe('ModelEndpointCache', () => {
  function make(fetchEndpoint: () => Promise<ServerModelEndpoint>) {
    let now = NOW;
    let calls = 0;
    const cache = new ModelEndpointCache({ fetchEndpoint: () => { calls++; return fetchEndpoint(); }, now: () => now, log: () => {} });
    return { cache, advance: (ms: number) => { now += ms; }, calls: () => calls };
  }

  test('lazy, cached for the run, one in-flight fetch for concurrent callers', async () => {
    const c = make(async () => SERVER);
    expect(c.calls()).toBe(0);
    const [a, b] = await Promise.all([c.cache.get(), c.cache.get()]);
    expect(a).toEqual(SERVER);
    expect(b).toEqual(SERVER);
    await c.cache.get();
    expect(c.calls()).toBe(1);
  });

  test('a 404 is cached as none for the run', async () => {
    const c = make(async () => { throw new NoModelEndpointError(); });
    expect(await c.cache.get()).toBeNull();
    c.advance(60 * 60 * 1000);
    expect(await c.cache.get()).toBeNull();
    expect(c.calls()).toBe(1);
  });

  test('other failures are unavailable for the backoff, then refetched', async () => {
    let fail = true;
    const c = make(async () => { if (fail) throw new Error('HTTP 502'); return SERVER; });
    expect(await c.cache.get()).toBe('unavailable');
    fail = false;
    expect(await c.cache.get()).toBe('unavailable');
    expect(c.calls()).toBe(1);
    c.advance(MODEL_ENDPOINT_FAILURE_BACKOFF_MS);
    expect(await c.cache.get()).toEqual(SERVER);
    expect(c.calls()).toBe(2);
  });

  test('invalidate after a 401 drops the key and refetches only after the backoff', async () => {
    const c = make(async () => SERVER);
    await c.cache.get();
    c.cache.invalidate();
    expect(await c.cache.get()).toBe('unavailable');
    expect(c.calls()).toBe(1);
    c.advance(MODEL_ENDPOINT_FAILURE_BACKOFF_MS);
    expect(await c.cache.get()).toEqual(SERVER);
    expect(c.calls()).toBe(2);
  });

  test('reset forgets everything, and a fetch from the previous run is discarded', async () => {
    let resolve!: (e: ServerModelEndpoint) => void;
    const c = make(() => new Promise<ServerModelEndpoint>((r) => { resolve = r; }));
    const stale = c.cache.get();
    c.cache.reset();
    resolve(SERVER);
    expect(await stale).toBe('unavailable');
    const fresh = c.cache.get();
    resolve({ ...SERVER, key: 'next-run' });
    expect(await fresh).toMatchObject({ key: 'next-run' });
  });
});

describe('api.anthropic.com: only the model API paths are forwarded', () => {
  const routes: Array<[string, ModelRoute]> = [
    ['gateway', gateway],
    ['proxy', resolveModelRoute(PROXY_ENV)],
    ['server endpoint', resolveModelRoute({}, { baseUrl: 'https://litellm.example.com', key: 'sk-team-endpoint', authHeader: 'authorization' })],
    ['direct', { kind: 'direct', apiKey: 'sk-ant-worker-held' }],
  ];

  const allowed: Array<[string, string]> = [
    ['POST', '/v1/messages'],
    ['POST', '/v1/messages?beta=true'],
    ['POST', '/v1/messages/count_tokens'],
    ['POST', '/v1/messages/count_tokens?beta=true'],
    ['GET', '/v1/models'],
    ['GET', '/v1/models?limit=1000'],
    ['GET', '/v1/models/claude-sonnet-5'],
  ];

  const refused: Array<[string, string]> = [
    ['GET', '/'],
    ['POST', '/v1/complete'],
    ['POST', '/v1/messages/batches'],
    ['GET', '/v1/messages/batches/abc'],
    ['POST', '/v1/files'],
    ['POST', '/key/generate'],
    ['GET', '/user/info'],
    ['POST', '/v1/messages/../key/generate'],
    ['POST', '/v1/messages/%2e%2e/key/generate'],
    ['POST', '/v1/messages/%2E%2E/%2E%2E/key/generate'],
    ['POST', '/v1/messages/.%2e/key/generate'],
    ['POST', '/v1/messages/./count_tokens'],
    ['POST', '//v1/messages'],
    ['POST', '/v1//messages'],
    ['POST', '/v1/messages/'],
    ['POST', '/v1/messages/count_tokens/extra'],
    ['POST', '/v1/messages%2fcount_tokens'],
    ['POST', '/v1/messages%2F..%2Fkey'],
    ['POST', '/v1/messages;x=1'],
    ['POST', '/V1/Messages'],
    ['POST', '/v1/messages\\..\\key'],
    ['GET', '/v1/models/..'],
    ['GET', '/v1/models/%2e%2e'],
    ['GET', '/v1/models/a/b'],
    ['GET', '/v1/messages'],
    ['DELETE', '/v1/messages'],
    ['POST', '/v1/models'],
  ];

  for (const [name, model] of routes) {
    for (const [method, path] of allowed) {
      test(`${name}: ${method} ${path} is forwarded with its query`, () => {
        const d = forwarded(rewriteOutbound({ url: `https://api.anthropic.com${path}`, method, headers: hostileHeaders() }, { model }));
        expect(d.url.endsWith(path)).toBe(true);
        expectNoContainerCredential(d.headers);
      });
    }
    for (const [method, path] of refused) {
      test(`${name}: ${method} ${path} is refused with 403 before any credential is added`, () => {
        const d = rewriteOutbound({ url: `https://api.anthropic.com${path}`, method, headers: hostileHeaders() }, { model });
        expect(d.action).toBe('reject');
        if (d.action !== 'reject') return;
        expect(d.status).toBe(403);
        expect(d.message.length).toBeLessThan(120);
        expect(JSON.stringify(d)).not.toContain('sk-');
        expect(JSON.stringify(d)).not.toContain('gw-secret-token');
      });
    }
  }

  test('an unconfigured route still refuses a disallowed path with 403, not 503', () => {
    const d = rewriteOutbound({ url: 'https://api.anthropic.com/key/generate', method: 'POST', headers: {} }, { model: resolveModelRoute({}) });
    expect(d).toMatchObject({ action: 'reject', status: 403 });
  });

  test('the allowlist is exactly the paths Claude Code needs', () => {
    expect(MODEL_API_ROUTES.map(r => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/messages', 'POST /v1/messages/count_tokens', 'GET /v1/models', 'GET /v1/models/:id',
    ]);
  });

  test('modelApiPathAllowed judges the raw path, not only the normalised one', () => {
    expect(modelApiPathAllowed('POST', 'https://api.anthropic.com/v1/messages')).toBe(true);
    expect(modelApiPathAllowed('post', 'https://api.anthropic.com/v1/messages')).toBe(true);
    expect(modelApiPathAllowed('POST', 'https://api.anthropic.com/v1/x/../messages')).toBe(false);
    expect(modelApiPathAllowed('POST', 'https://api.anthropic.com/v1/%6dessages')).toBe(false);
  });

  test('the egress handler passes the request method', async () => {
    const src = await Bun.file(new URL('./egress.ts', import.meta.url)).text();
    expect(src).toMatch(/rewriteOutbound\(\s*\{ url: request\.url, method: request\.method, headers: request\.headers \}/);
  });
});

describe('endpoint model mapping (the cloud path applies what host runners apply via env)', () => {
  test('aliases map listed ids and leave the rest unchanged', () => {
    const e = { kind: 'url', models: { 'claude-haiku-4-5-20251001': 'claude-haiku-4-5' } };
    expect(mapEndpointModel(e, 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(mapEndpointModel(e, 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });
  test('openrouter names Anthropic models anthropic/<undated, dotted>, as buildd core does', () => {
    const e = { kind: 'openrouter', models: {} };
    expect(mapEndpointModel(e, 'claude-haiku-4-5-20251001')).toBe('anthropic/claude-haiku-4.5');
    expect(mapEndpointModel(e, 'claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(mapEndpointModel(e, 'anthropic/claude-opus-5')).toBe('anthropic/claude-opus-5');
  });
  test('only the message endpoints carry a model to rewrite', () => {
    expect(isModelRewritePath('POST', 'https://api.anthropic.com/v1/messages?beta=true')).toBe(true);
    expect(isModelRewritePath('POST', 'https://api.anthropic.com/v1/messages/count_tokens')).toBe(true);
    expect(isModelRewritePath('GET', 'https://api.anthropic.com/v1/models')).toBe(false);
  });
  test('rewrites the model field and nothing else; non-JSON or no change returns null', () => {
    const map = (id: string) => (id === 'claude-haiku-4-5-20251001' ? 'claude-haiku-4-5' : id);
    const out = rewriteModelInBody(JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'model: x' }] }), map);
    expect(JSON.parse(out!)).toEqual({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'model: x' }] });
    expect(rewriteModelInBody(JSON.stringify({ model: 'claude-sonnet-5' }), map)).toBeNull();
    expect(rewriteModelInBody('not json', map)).toBeNull();
    expect(rewriteModelInBody(JSON.stringify([1]), map)).toBeNull();
  });
  test('the forward decision for a server endpoint carries its model mapper', () => {
    const server = { baseUrl: 'https://litellm.example.com', key: 'k', authHeader: 'authorization' as const, kind: 'url', models: { a: 'b' } };
    const d = rewriteOutbound({ url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: new Headers() }, { model: resolveModelRoute({}, server) });
    expect(d.action).toBe('forward');
    if (d.action !== 'forward') return;
    expect(d.mapModel?.('a')).toBe('b');
    const g = rewriteOutbound({ url: 'https://api.anthropic.com/v1/models', method: 'GET', headers: new Headers() }, { model: resolveModelRoute({}, server) });
    expect(g.action === 'forward' && g.mapModel).toBeFalsy();
  });
});

describe('endpointRejectedKey: only a 401 means the key is bad', () => {
  test('401 drops the key; a 403 is a per-request refusal (e.g. a model this key may not use)', () => {
    expect(endpointRejectedKey(401)).toBe(true);
    expect(endpointRejectedKey(403)).toBe(false);
    expect(endpointRejectedKey(200)).toBe(false);
  });
});
