import { describe, it, expect } from 'bun:test';
import { buildAgentBaseEnv, RUNNER_ENV_PASSTHROUGH, withWorkerResourceAttribute } from './agent-env';

const NO_BROWSER = { available: false, searched: [], attempts: [] };

describe('agent env allowlist', () => {
  // The container image (apps/runner/Dockerfile.once) sets this so Claude Code
  // makes no telemetry / error-report / auto-update calls through the egress
  // proxy. It only works if it reaches the agent subprocess.
  it('passes CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC through', () => {
    expect(RUNNER_ENV_PASSTHROUGH.has('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe(true);
    const env = buildAgentBaseEnv({ HOME: '/home/bun', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, NO_BROWSER);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('still drops runner coordination secrets', () => {
    const env = buildAgentBaseEnv({ HOME: '/home/bun', BUILDD_API_KEY: 'bld_x', BUILDD_SERVER: 'http://x' }, NO_BROWSER);
    expect(env.BUILDD_API_KEY).toBeUndefined();
    expect(env.BUILDD_SERVER).toBeUndefined();
  });
});

describe('agent env: OpenTelemetry (cloud-runner sets these on the container)', () => {
  const OTEL = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_RESOURCE_ATTRIBUTES: 'buildd.task_id=t,buildd.attempt=1',
    OTEL_LOG_TOOL_DETAILS: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    TRACEPARENT: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
  };

  it('passes the non-secret telemetry settings through to Claude Code', () => {
    const env = buildAgentBaseEnv({ HOME: '/home/bun', ...OTEL }, NO_BROWSER);
    for (const [k, v] of Object.entries(OTEL)) expect(env[k]).toBe(v);
  });

  it('never passes OTLP headers (they can carry a collector credential) or content opt-ins', () => {
    const env = buildAgentBaseEnv({
      HOME: '/home/bun', ...OTEL,
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer secret',
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'Authorization=Bearer secret',
      OTEL_LOG_USER_PROMPTS: '1', OTEL_LOG_TOOL_CONTENT: '1', OTEL_LOG_RAW_API_BODIES: '1',
    }, NO_BROWSER);
    for (const k of ['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_LOGS_HEADERS', 'OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_TOOL_CONTENT', 'OTEL_LOG_RAW_API_BODIES']) {
      expect(k in env).toBe(false);
    }
  });

  it('adds the worker id to the resource attributes when telemetry is on', () => {
    const env = buildAgentBaseEnv({ HOME: '/home/bun', ...OTEL }, NO_BROWSER);
    withWorkerResourceAttribute(env, 'w-1');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('buildd.task_id=t,buildd.attempt=1,buildd.worker_id=w-1');
  });

  it('creates the attribute when telemetry is on without resource attributes', () => {
    const env: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: '1' };
    withWorkerResourceAttribute(env, 'a,b');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('buildd.worker_id=a%2Cb');
  });

  it('leaves the env alone when telemetry is off or the id is already there', () => {
    const off: Record<string, string> = { HOME: '/h' };
    withWorkerResourceAttribute(off, 'w-1');
    expect(off).toEqual({ HOME: '/h' });
    const already: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_RESOURCE_ATTRIBUTES: 'buildd.worker_id=x' };
    withWorkerResourceAttribute(already, 'w-1');
    expect(already.OTEL_RESOURCE_ATTRIBUTES).toBe('buildd.worker_id=x');
  });
});
