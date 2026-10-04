/**
 * Per-task token for the agent's buildd MCP auth (src/agent-task-token.ts):
 * the strict response parse, the fallback-to-runner-key decision for every
 * failure mode, the escape hatch, and the real BuilddClient mint call.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  AGENT_TASK_TOKEN_TTL_MS,
  agentTaskTokenEnabled,
  parseAgentTaskTokenResponse,
  resolveAgentBuilddAuth,
} from '../../src/agent-task-token';
import { buildWorkerSecretValues } from '../../src/evidence-writer';
import { BuilddClient } from '../../src/buildd';

const TASK = '11111111-2222-4333-8444-555555555555';
const KEY = 'bld_runnerkey_abcdefghijklmnop';
const TOKEN = 'bldt_payload.signature_abcdefghijklmnop';
const FUTURE = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function okBody(over: Record<string, unknown> = {}) {
  return { token: TOKEN, taskId: TASK, expiresAt: FUTURE(), ...over };
}

function refusal(status: number) {
  return Object.assign(new Error(`refused ${status}`), { status });
}

describe('parseAgentTaskTokenResponse', () => {
  test('accepts a well-formed response', () => {
    const p = parseAgentTaskTokenResponse(okBody(), TASK);
    expect(p.token).toBe(TOKEN);
    expect(p.expiresAt).toBeGreaterThan(Date.now());
  });

  test.each([
    ['no token', { token: undefined }],
    ['a runner key instead of a task token', { token: 'bld_abc' }],
    ['a bare prefix', { token: 'bldt_' }],
    ['another task', { taskId: '99999999-2222-4333-8444-555555555555' }],
    ['no expiresAt', { expiresAt: undefined }],
    ['an unparseable expiresAt', { expiresAt: 'soon' }],
    ['an expired token', { expiresAt: new Date(Date.now() - 1000).toISOString() }],
  ])('rejects %s, without echoing the token', (_name, over) => {
    let msg = '';
    try { parseAgentTaskTokenResponse(okBody(over), TASK); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toBe('');
    expect(msg).not.toContain(TOKEN);
  });
});

describe('agentTaskTokenEnabled', () => {
  test('on by default', () => {
    expect(agentTaskTokenEnabled({})).toBe(true);
    expect(agentTaskTokenEnabled({ BUILDD_AGENT_TASK_TOKEN: '1' })).toBe(true);
  });
  test.each(['0', 'false', 'off', 'no', ' 0 '])('off for %p', v => {
    expect(agentTaskTokenEnabled({ BUILDD_AGENT_TASK_TOKEN: v })).toBe(false);
  });
});

describe('resolveAgentBuilddAuth', () => {
  test('mint success → the task token, minted for this task at the max ttl', async () => {
    const calls: Array<[string, number]> = [];
    const warns: string[] = [];
    const auth = await resolveAgentBuilddAuth({
      runnerKey: KEY, taskId: TASK, env: {}, warn: l => warns.push(l),
      mint: async (taskId, ttlMs) => { calls.push([taskId, ttlMs]); return okBody(); },
    });
    expect(auth).toMatchObject({ source: 'task-token', token: TOKEN });
    expect(calls).toEqual([[TASK, AGENT_TASK_TOKEN_TTL_MS]]);
    expect(AGENT_TASK_TOKEN_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(warns).toEqual([]);
  });

  const failures: Array<[string, () => Promise<unknown>, string]> = [
    ['network error', async () => { throw new TypeError('fetch failed'); }, 'network error'],
    ['401', async () => { throw refusal(401); }, 'HTTP 401'],
    ['403 (no runner scopes / trigger key)', async () => { throw refusal(403); }, 'HTTP 403'],
    ['404 (old server / no canClaim)', async () => { throw refusal(404); }, 'HTTP 404'],
    ['503 (no signing secret)', async () => { throw refusal(503); }, 'HTTP 503'],
    ['500', async () => { throw refusal(500); }, 'HTTP 500'],
    ['malformed body', async () => ({ token: 'nope' }), 'no per-task token'],
    ['outbox placeholder {}', async () => ({}), 'no per-task token'],
    ['wrong task', async () => okBody({ taskId: 'other' }), 'different task'],
    ['a message that quotes a token', async () => { throw new Error(`boom ${TOKEN}`); }, 'boom bldt_[redacted]'],
  ];

  for (const [name, mint, reason] of failures) {
    test(`${name} → runner key, exactly one warning with the reason`, async () => {
      const warns: string[] = [];
      const auth = await resolveAgentBuilddAuth({ runnerKey: KEY, taskId: TASK, env: {}, warn: l => warns.push(l), mint });
      expect(auth).toMatchObject({ source: 'runner-key', token: KEY, reason: 'mint-failed' });
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(reason);
      expect(warns[0]).toContain(TASK.slice(0, 8));
      expect(warns[0]).not.toContain(TASK);
      expect(warns[0]).not.toContain(KEY);
      expect(warns[0]).not.toContain(TOKEN);
    });
  }

  test('a hung mint times out and falls back', async () => {
    const warns: string[] = [];
    const auth = await resolveAgentBuilddAuth({
      runnerKey: KEY, taskId: TASK, env: {}, warn: l => warns.push(l), timeoutMs: 20,
      mint: (_t, _ttl, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason))),
    });
    expect(auth.source).toBe('runner-key');
    expect(warns[0]).toContain('timed out');
  });

  test('a client without the method falls back', async () => {
    const warns: string[] = [];
    const auth = await resolveAgentBuilddAuth({ runnerKey: KEY, taskId: TASK, env: {}, warn: l => warns.push(l), mint: undefined });
    expect(auth.source).toBe('runner-key');
    expect(warns).toHaveLength(1);
  });

  test('BUILDD_AGENT_TASK_TOKEN=0 → runner key, no mint call, no warning', async () => {
    let called = 0;
    const warns: string[] = [];
    const auth = await resolveAgentBuilddAuth({
      runnerKey: KEY, taskId: TASK, env: { BUILDD_AGENT_TASK_TOKEN: '0' }, warn: l => warns.push(l),
      mint: async () => { called++; return okBody(); },
    });
    expect(auth).toMatchObject({ source: 'runner-key', token: KEY, reason: 'disabled' });
    expect(called).toBe(0);
    expect(warns).toEqual([]);
  });

  test('a runner already on a task token (cloud) uses it as is, no mint', async () => {
    let called = 0;
    const auth = await resolveAgentBuilddAuth({
      runnerKey: TOKEN, taskId: TASK, env: {}, warn: () => { throw new Error('no warning expected'); },
      mint: async () => { called++; return okBody(); },
    });
    expect(auth).toMatchObject({ source: 'runner-key', token: TOKEN, reason: 'runner-key-is-task-token' });
    expect(called).toBe(0);
  });
});

describe('buildWorkerSecretValues', () => {
  test('includes the agent task token so the per-worker redactor strips it', () => {
    const values = buildWorkerSecretValues(KEY, {} as any, TOKEN);
    expect(values).toContainEqual({ label: 'agentTaskToken', value: TOKEN });
    expect(values).toContainEqual({ label: 'BUILDD_API_KEY', value: KEY });
  });
  test('omitted when there is none', () => {
    expect(buildWorkerSecretValues(KEY, {} as any).some(v => v.label === 'agentTaskToken')).toBe(false);
  });
});

describe('BuilddClient.mintTaskToken', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('POSTs { taskId, ttlMs } to /api/runner/task-token with the runner key', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify(okBody()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const client = new BuilddClient({ builddServer: 'http://srv.test', apiKey: KEY } as any);
    const body = await client.mintTaskToken(TASK, AGENT_TASK_TOKEN_TTL_MS);
    expect((body as any).token).toBe(TOKEN);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://srv.test/api/runner/task-token');
    expect(seen[0].init.method).toBe('POST');
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ taskId: TASK, ttlMs: AGENT_TASK_TOKEN_TTL_MS });
    const headers = new Headers(seen[0].init.headers as HeadersInit);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  test('a refusal rejects with its status (drives the fallback reason)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'no secret' }), { status: 503 })) as unknown as typeof fetch;
    const client = new BuilddClient({ builddServer: 'http://srv.test', apiKey: KEY } as any);
    let status: unknown;
    try { await client.mintTaskToken(TASK, 1000); } catch (e) { status = (e as any).status; }
    expect(status).toBe(503);
  });
});
