import { describe, expect, test } from 'bun:test';
import { INTERCEPTED_HOSTS, CONTAINER_CREDENTIAL_HEADERS } from './outbound';
import {
  OTLP_DEFAULT_PROTOCOL,
  otelContainerEnv,
  otlpInterceptHosts,
  otlpResourceAttributes,
  parseOtlpConfig,
  rewriteOtlp,
  type OtelEgressEnv,
} from './otel';

const ENDPOINT = 'https://otel.example.com';
const RUN = { taskId: 'task-abc', attempt: 2 };
const FIXED_BYTES = (n: number) => new Uint8Array(n).fill(0xab);
const AUTH: OtelEgressEnv = {
  OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
  OTEL_EXPORTER_OTLP_AUTH_HEADER: 'x-otlp-key',
  OTEL_EXPORTER_OTLP_AUTH_VALUE: 'otlp-secret-value',
};

describe('parseOtlpConfig', () => {
  test('no endpoint means not configured', () => {
    expect(parseOtlpConfig({})).toBeNull();
    expect(parseOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toBeNull();
    expect(parseOtlpConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_LOG_TOOL_DETAILS: '1' })).toBeNull();
  });

  test('https endpoint, default protocol', () => {
    const c = parseOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: `${ENDPOINT}/` });
    expect(c).toEqual({ ok: true, endpoint: ENDPOINT, origin: ENDPOINT, hostname: 'otel.example.com', scheme: 'https', protocol: OTLP_DEFAULT_PROTOCOL });
    expect(OTLP_DEFAULT_PROTOCOL).toBe('http/protobuf');
  });

  test('keeps a base path', () => {
    const c = parseOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: `${ENDPOINT}/otlp`, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' });
    expect(c).toMatchObject({ ok: true, endpoint: `${ENDPOINT}/otlp`, protocol: 'http/json' });
  });

  test('refuses plain http except the local allowlist', () => {
    expect(parseOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example.com:4318' })).toMatchObject({ ok: false });
    expect(parseOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://host.docker.internal:4318' }))
      .toMatchObject({ ok: true, scheme: 'http', origin: 'http://host.docker.internal:4318' });
    expect(parseOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://otel.example.com' })).toMatchObject({ ok: false });
  });

  test('refuses credentials, query, fragment, grpc and unknown protocols', () => {
    for (const raw of ['https://user:pw@otel.example.com', 'https://otel.example.com/?k=v', 'https://otel.example.com/#x', 'not a url']) {
      expect(parseOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: raw })).toMatchObject({ ok: false });
    }
    expect(parseOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toMatchObject({ ok: false });
    expect(parseOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL: 'carrier-pigeon' })).toMatchObject({ ok: false });
  });

  test('refuses a host the model or GitHub rules already own', () => {
    for (const host of [...INTERCEPTED_HOSTS, 'gateway.ai.cloudflare.com']) {
      expect(parseOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: `https://${host}` })).toMatchObject({ ok: false });
    }
  });
});

describe('otelContainerEnv', () => {
  test('nothing at all without an endpoint', () => {
    expect(otelContainerEnv({}, RUN)).toEqual({});
    expect(otelContainerEnv({ OTEL_LOG_TOOL_DETAILS: '1', OTEL_TRACES_BETA: '1', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }, RUN)).toEqual({});
  });

  test('endpoint set: the Claude Code vars and the dispatch attributes', () => {
    expect(otelContainerEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }, RUN)).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_RESOURCE_ATTRIBUTES: 'buildd.task_id=task-abc,buildd.attempt=2',
    });
  });

  test('security: auth never reaches the container, and no OTLP headers var is set', () => {
    const env = otelContainerEnv({ ...AUTH, OTEL_LOG_TOOL_DETAILS: '1', OTEL_TRACES_BETA: '1' } as never, RUN, { randomBytes: FIXED_BYTES });
    expect(Object.values(env).join('\n')).not.toContain('otlp-secret-value');
    expect(Object.keys(env).join('\n')).not.toContain('AUTH');
    for (const key of Object.keys(env)) expect(key.endsWith('_HEADERS')).toBe(false);
  });

  test('tool details only with the opt-in; prompt content never', () => {
    expect(otelContainerEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }, RUN).OTEL_LOG_TOOL_DETAILS).toBeUndefined();
    expect(otelContainerEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_LOG_TOOL_DETAILS: 'yes' }, RUN).OTEL_LOG_TOOL_DETAILS).toBeUndefined();
    const on = otelContainerEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_LOG_TOOL_DETAILS: '1' }, RUN);
    expect(on.OTEL_LOG_TOOL_DETAILS).toBe('1');
    expect(on.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(on.OTEL_LOG_TOOL_CONTENT).toBeUndefined();
  });

  test('traces opt-in: beta flag, traces exporter and one TRACEPARENT per dispatch', () => {
    const env = otelContainerEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_TRACES_BETA: '1' }, RUN, { randomBytes: FIXED_BYTES });
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe('1');
    expect(env.OTEL_TRACES_EXPORTER).toBe('otlp');
    expect(env.TRACEPARENT).toBe(`00-${'ab'.repeat(16)}-${'ab'.repeat(8)}-01`);
    const a = otelContainerEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_TRACES_BETA: '1' }, RUN).TRACEPARENT!;
    const b = otelContainerEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_TRACES_BETA: '1' }, RUN).TRACEPARENT!;
    expect(a).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(a).not.toBe(b);
    expect(otelContainerEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }, RUN).TRACEPARENT).toBeUndefined();
  });

  test('an invalid endpoint fails loudly instead of silently dropping telemetry', () => {
    expect(() => otelContainerEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example.com' }, RUN)).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });
});

describe('otlpResourceAttributes', () => {
  test('worker id when known, percent-encoded values', () => {
    expect(otlpResourceAttributes({ taskId: 't', attempt: 1, workerId: 'w-1' })).toBe('buildd.task_id=t,buildd.attempt=1,buildd.worker_id=w-1');
    expect(otlpResourceAttributes({ taskId: 'a,b=c', attempt: 1 })).toBe('buildd.task_id=a%2Cb%3Dc,buildd.attempt=1');
  });
});

describe('otlpInterceptHosts', () => {
  test('nothing extra without an endpoint (installEgressHandlers unchanged)', () => {
    expect(otlpInterceptHosts({})).toEqual({ https: [], http: [] });
    expect(otlpInterceptHosts({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example.com' })).toEqual({ https: [], http: [] });
  });

  test('https endpoint: its host over https, plus http so plaintext is refused', () => {
    expect(otlpInterceptHosts({ OTEL_EXPORTER_OTLP_ENDPOINT: `${ENDPOINT}/otlp` })).toEqual({ https: ['otel.example.com'], http: ['otel.example.com'] });
  });

  test('local http endpoint: http only', () => {
    expect(otlpInterceptHosts({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://host.docker.internal:4318' })).toEqual({ https: [], http: ['host.docker.internal'] });
  });
});

describe('rewriteOtlp', () => {
  const containerHeaders = {
    'content-type': 'application/x-protobuf',
    authorization: 'Bearer container-supplied',
    'x-api-key': 'container-supplied',
    'x-otlp-key': 'container-supplied',
    cookie: 'a=b',
  };

  test('adds the Worker auth for the OTLP origin, after stripping container auth', () => {
    const d = rewriteOtlp({ url: `${ENDPOINT}/v1/logs`, headers: containerHeaders }, AUTH);
    expect(d?.action).toBe('forward');
    if (d?.action !== 'forward') throw new Error('unreachable');
    expect(d.url).toBe(`${ENDPOINT}/v1/logs`);
    expect(d.injected).toBe('otlp');
    expect(d.headers.get('x-otlp-key')).toBe('otlp-secret-value');
    for (const h of CONTAINER_CREDENTIAL_HEADERS) expect(d.headers.get(h)).toBeNull();
    expect(d.headers.get('content-type')).toBe('application/x-protobuf');
  });

  test('header name defaults to authorization', () => {
    const d = rewriteOtlp({ url: `${ENDPOINT}/v1/logs`, headers: containerHeaders }, {
      OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_EXPORTER_OTLP_AUTH_VALUE: 'Bearer otlp-secret-value',
    });
    if (d?.action !== 'forward') throw new Error('expected forward');
    expect(d.headers.get('authorization')).toBe('Bearer otlp-secret-value');
  });

  test('no auth configured: forwarded with container auth stripped, nothing added', () => {
    const d = rewriteOtlp({ url: `${ENDPOINT}/v1/metrics`, headers: containerHeaders }, { OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT });
    if (d?.action !== 'forward') throw new Error('expected forward');
    expect(d.injected).toBe('none');
    expect(d.headers.get('authorization')).toBeNull();
    expect(d.headers.get('x-api-key')).toBeNull();
  });

  test('look-alike and other origins get nothing (not an OTLP request)', () => {
    for (const url of [
      'https://otel.example.com.evil.test/v1/logs',
      'https://evil-otel.example.com/v1/logs',
      'https://sub.otel.example.com/v1/logs',
      'https://otel.example.com:8443/v1/logs',
      'https://example.com/v1/logs',
    ]) {
      expect(rewriteOtlp({ url, headers: containerHeaders }, AUTH)).toBeNull();
    }
  });

  test('plain http to an https OTLP host is refused, never credentialed', () => {
    expect(rewriteOtlp({ url: 'http://otel.example.com/v1/logs', headers: {} }, AUTH)).toMatchObject({ action: 'reject', status: 403 });
  });

  test('local http endpoint is matched by exact origin including port', () => {
    const env = { ...AUTH, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://host.docker.internal:4318' };
    expect(rewriteOtlp({ url: 'http://host.docker.internal:4318/v1/logs', headers: {} }, env)).toMatchObject({ action: 'forward', injected: 'otlp' });
    // Same host, other port: e.g. a local buildd. Not ours.
    expect(rewriteOtlp({ url: 'http://host.docker.internal:8798/api/tasks/x', headers: {} }, env)).toBeNull();
  });

  test('an unusable auth header name refuses the export instead of sending it unauthenticated', () => {
    for (const name of ['host', 'content-length', 'bad header']) {
      expect(rewriteOtlp({ url: `${ENDPOINT}/v1/logs`, headers: {} }, { ...AUTH, OTEL_EXPORTER_OTLP_AUTH_HEADER: name }))
        .toMatchObject({ action: 'reject', status: 503 });
    }
  });

  test('no endpoint configured: never an OTLP request (egress unchanged)', () => {
    for (const url of [`${ENDPOINT}/v1/logs`, 'https://api.anthropic.com/v1/messages', 'https://github.com/a/b.git']) {
      expect(rewriteOtlp({ url, headers: containerHeaders }, {})).toBeNull();
      expect(rewriteOtlp({ url, headers: containerHeaders }, { OTEL_EXPORTER_OTLP_AUTH_HEADER: 'x', OTEL_EXPORTER_OTLP_AUTH_VALUE: 'v' })).toBeNull();
    }
  });
});
