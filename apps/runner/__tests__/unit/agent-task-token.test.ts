/**
 * Per-task token for the agent's buildd MCP auth (src/agent-task-token.ts):
 * the strict response parse, the fallback-to-runner-key decision for every
 * failure mode, the escape hatch, and the real BuilddClient mint call.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  AGENT_TASK_TOKEN_TTL_MS,
  agentTaskTokenEnabled,
  isOrchestrationTask,
  looksLikePersonSessionBearer,
  parseAgentTaskTokenResponse,
  resolveAgentBuilddAuth,
  usesAdminBuilddActions,
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

  test("POSTs level only for an admin request", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(okBody({ level: 'admin' })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const client = new BuilddClient({ builddServer: 'http://srv.test', apiKey: KEY } as any);
    await client.mintTaskToken(TASK, 1000, undefined, 'admin');
    expect(bodies).toEqual([{ taskId: TASK, ttlMs: 1000, level: 'admin' }]);
  });

  test('a refusal rejects with its status (drives the fallback reason)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'no secret' }), { status: 503 })) as unknown as typeof fetch;
    const client = new BuilddClient({ builddServer: 'http://srv.test', apiKey: KEY } as any);
    let status: unknown;
    try { await client.mintTaskToken(TASK, 1000); } catch (e) { status = (e as any).status; }
    expect(status).toBe(503);
  });
});

describe('isOrchestrationTask', () => {
  test.each([
    ['organizer role', { roleSlug: 'organizer' }, true],
    ['planning mode', { mode: 'planning' }, true],
    ['heartbeat check-in on another role', { roleSlug: 'builder', context: { heartbeat: true } }, true],
    ['builder', { roleSlug: 'builder', mode: 'execution' }, false],
    ['researcher', { roleSlug: 'researcher' }, false],
    ['no role', {}, false],
    ['heartbeat flag not true', { context: { heartbeat: 'yes' } }, false],
  ])('%s → %p', (_n, task, expected) => {
    expect(isOrchestrationTask(task as any)).toBe(expected);
  });
});

describe('usesAdminBuilddActions', () => {
  test.each([
    // The weekly consolidation pass is consolidate_knowledge, an admin action.
    ['consolidator role', { roleSlug: 'consolidator' }, true],
    ['builder', { roleSlug: 'builder' }, false],
    ['organizer (covered by isOrchestrationTask instead)', { roleSlug: 'organizer' }, false],
    ['no role', {}, false],
    ['no task', undefined, false],
  ])('%s → %p', (_n, task, expected) => {
    expect(usesAdminBuilddActions(task as any)).toBe(expected);
  });
});

describe('resolveAgentBuilddAuth for an admin-action role', () => {
  test('runner key, no mint, one info line with the reason, no warning', async () => {
    let called = 0;
    const infos: string[] = [];
    const warns: string[] = [];
    const auth = await resolveAgentBuilddAuth({
      runnerKey: KEY, taskId: TASK, env: {}, adminRole: true,
      info: l => infos.push(l), warn: l => warns.push(l),
      mint: async () => { called++; return okBody(); },
    });
    expect(auth).toMatchObject({ source: 'runner-key', token: KEY, reason: 'admin-role' });
    expect(called).toBe(0);
    expect(warns).toEqual([]);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('source=runner-key reason=admin-role');
    expect(infos[0]).not.toContain(KEY);
  });

  test('the escape hatch and a task-token runner key still win', async () => {
    expect(await resolveAgentBuilddAuth({ runnerKey: KEY, taskId: TASK, env: { BUILDD_AGENT_TASK_TOKEN: '0' }, adminRole: true, mint: undefined }))
      .toMatchObject({ reason: 'disabled' });
    expect(await resolveAgentBuilddAuth({ runnerKey: TOKEN, taskId: TASK, env: {}, adminRole: true, mint: undefined }))
      .toMatchObject({ reason: 'runner-key-is-task-token' });
  });
});

describe('resolveAgentBuilddAuth for an orchestration task', () => {
  test('mints an admin-level token for the task, no warning', async () => {
    const calls: Array<[string, number, string | undefined]> = [];
    const warns: string[] = [];
    const auth = await resolveAgentBuilddAuth({
      runnerKey: KEY, taskId: TASK, env: {}, orchestration: true, warn: l => warns.push(l), info: () => {},
      mint: async (taskId, ttlMs, _signal, level) => { calls.push([taskId, ttlMs, level]); return okBody({ level: 'admin' }); },
    });
    expect(auth).toMatchObject({ source: 'task-token', token: TOKEN, level: 'admin' });
    expect(calls).toEqual([[TASK, AGENT_TASK_TOKEN_TTL_MS, 'admin']]);
    expect(warns).toEqual([]);
  });

  const refusals: Array<[string, () => Promise<unknown>, string]> = [
    ['a worker-level runner key (403)', async () => { throw refusal(403); }, 'not an admin key'],
    ['an older server that ignores level and mints a worker token', async () => okBody(), 'did not grant an admin token'],
    ['an older server that says worker', async () => okBody({ level: 'worker' }), 'did not grant an admin token'],
    ['a network error', async () => { throw new TypeError('fetch failed'); }, 'network error'],
    ['no signing secret (503)', async () => { throw refusal(503); }, 'HTTP 503'],
  ];
  for (const [name, mint, reason] of refusals) {
    test(`${name} → runner key, one info line with the reason, no warning`, async () => {
      const infos: string[] = [];
      const warns: string[] = [];
      const auth = await resolveAgentBuilddAuth({
        runnerKey: KEY, taskId: TASK, env: {}, orchestration: true,
        info: l => infos.push(l), warn: l => warns.push(l), mint,
      });
      expect(auth).toMatchObject({ source: 'runner-key', token: KEY, reason: 'orchestration-role' });
      expect(warns).toEqual([]);
      expect(infos).toHaveLength(1);
      expect(infos[0]).toContain('source=runner-key reason=orchestration-role');
      expect(infos[0]).toContain(reason);
      expect(infos[0]).not.toContain(KEY);
      expect(infos[0]).not.toContain(TOKEN);
    });
  }

  test('a worker task never asks for admin, and keeps a worker token it is given', async () => {
    const levels: Array<string | undefined> = [];
    const auth = await resolveAgentBuilddAuth({
      runnerKey: KEY, taskId: TASK, env: {}, warn: () => {},
      mint: async (_t, _ttl, _s, level) => { levels.push(level); return okBody(); },
    });
    expect(levels).toEqual([undefined]);
    expect(auth).toMatchObject({ source: 'task-token', level: 'worker' });
  });

  test('the escape hatch and a task-token runner key still win, with no mint', async () => {
    let called = 0;
    const mint = async () => { called++; return okBody({ level: 'admin' }); };
    expect(await resolveAgentBuilddAuth({ runnerKey: KEY, taskId: TASK, env: { BUILDD_AGENT_TASK_TOKEN: '0' }, orchestration: true, mint }))
      .toMatchObject({ source: 'runner-key', reason: 'disabled' });
    expect(await resolveAgentBuilddAuth({ runnerKey: TOKEN, taskId: TASK, env: {}, orchestration: true, mint }))
      .toMatchObject({ source: 'runner-key', reason: 'runner-key-is-task-token' });
    expect(called).toBe(0);
  });

  test('an admin-action role that is also orchestration keeps the runner key without minting', async () => {
    let called = 0;
    const auth = await resolveAgentBuilddAuth({
      runnerKey: KEY, taskId: TASK, env: {}, orchestration: true, adminRole: true, info: () => {},
      mint: async () => { called++; return okBody({ level: 'admin' }); },
    });
    expect(auth).toMatchObject({ source: 'runner-key', reason: 'admin-role' });
    expect(called).toBe(0);
  });
});

// A runner agent never acts as a person (docs/specs/workflow-state-kernel.md, T5 `human:`).
// The server reads a person only from an OAuth session bearer; the agent's buildd
// credential is a per-task token or the runner's key, and never a session bearer.
describe('a runner agent never carries a person\'s sign-in session', () => {
  const SESSION = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJl';

  test('the shape test matches an OAuth access token and neither buildd key form', () => {
    expect(looksLikePersonSessionBearer(SESSION)).toBe(true);
    expect(looksLikePersonSessionBearer(KEY)).toBe(false);
    expect(looksLikePersonSessionBearer(TOKEN)).toBe(false);
    expect(looksLikePersonSessionBearer('')).toBe(false);
  });

  test('every credential the agent is given on a buildd key runner is a buildd key or a task token', async () => {
    const cases = [
      { env: {}, mint: async () => okBody() },
      { env: {}, mint: async () => { throw refusal(500); } },
      { env: { BUILDD_AGENT_TASK_TOKEN: '0' }, mint: async () => okBody() },
      { env: {}, adminRole: true, mint: async () => okBody() },
      { env: {}, orchestration: true, mint: async () => { throw refusal(403); } },
    ];
    for (const c of cases) {
      const auth = await resolveAgentBuilddAuth({ runnerKey: KEY, taskId: TASK, warn: () => {}, info: () => {}, ...c });
      expect(looksLikePersonSessionBearer(auth.token)).toBe(false);
      expect(auth.token.startsWith('bld_') || auth.token.startsWith('bldt_')).toBe(true);
    }
  });

  test('a runner started on a session bearer still gives the agent a task token when one is minted', async () => {
    const auth = await resolveAgentBuilddAuth({ runnerKey: SESSION, taskId: TASK, env: {}, warn: () => {}, mint: async () => okBody() });
    expect(auth).toMatchObject({ source: 'task-token', token: TOKEN });
  });

  test.each([
    ['the mint fails', { env: {}, mint: async () => { throw refusal(500); } }],
    ['task tokens are switched off', { env: { BUILDD_AGENT_TASK_TOKEN: '0' }, mint: async () => okBody() }],
    ['the role needs admin actions', { env: {}, adminRole: true, mint: async () => okBody() }],
    ['an orchestration mint is refused', { env: {}, orchestration: true, mint: async () => { throw refusal(403); } }],
  ])('a runner started on a session bearer never hands it to the agent when %s', async (_name, c) => {
    const warns: string[] = [];
    const auth = await resolveAgentBuilddAuth({ runnerKey: SESSION, taskId: TASK, warn: l => warns.push(l), info: () => {}, ...c });
    expect(auth).toMatchObject({ source: 'none', token: '', reason: 'runner-key-is-person-session' });
    expect(warns.some(l => l.includes('sign-in session'))).toBe(true);
    expect(warns.join('\n')).not.toContain(SESSION);
  });
});
