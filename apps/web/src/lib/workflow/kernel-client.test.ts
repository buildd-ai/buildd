/**
 * The one client doors submit kernel commands through
 * (docs/specs/workflow-kernel-library.md §3, AC-12): where a command runs in
 * each mode, that an unreachable control plane applies nothing here, that a
 * retry reuses the key, and that lockstep is not consulted.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { handleCommandRequest } from './command-api';
import {
  ControlPlaneUnavailableError, KernelCommandRefusedError, MODE_FRESH_MS, MODE_STALE_MS, controlPlaneUnavailableResponse,
  kernelMode, resetKernelModeCache, submitKernelCommand, type ClientDeps,
} from './kernel-client';
import type { CommandLedger } from './command-ledger';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const DELIVERY = '33333333-3333-4333-8333-333333333333';
const input = { workspaceId: WS, installationId: 1, repoFullName: 'acme/w', prNumber: 7, headSha: 'H1', door: 'dashboard', actor: `human:${USER}` };
const principal = { kind: 'user' as const, id: USER };
const OWN = { EXECUTION_MODE: 'own', KERNEL_COMMAND_SECRET: 'k1:s3cret' };

afterEach(() => resetKernelModeCache());

function local() {
  const ran: string[] = [];
  return {
    ran,
    deps: {
      run: (async (op: string) => { ran.push(op); return { merged: true, outcome: 'merged', where: 'here' }; }) as ClientDeps['run'],
      deliveryAfter: async () => ({ id: DELIVERY, version: 4 }),
      sleep: async () => {},
      host: () => 'web' as const,
    } satisfies ClientDeps,
  };
}

const answer = (o: Record<string, unknown> = {}) => Response.json({ v: 1, op: 'land', idempotencyKey: 'k', result: { merged: true, where: 'control-plane' }, delivery: { id: DELIVERY, version: 5 }, host: 'control-plane', replayed: false, ...o });

describe('the mode', () => {
  it('on the control plane: its own EXECUTION_MODE', async () => {
    expect(await kernelMode({ host: () => 'control-plane', env: { EXECUTION_MODE: 'own' } })).toBe('own');
    expect(await kernelMode({ host: () => 'control-plane', env: {} })).toBe('shadow');
  });

  it('on the web host: an explicit EXECUTION_MODE wins; off Vercel with none it is shadow and reads nothing', async () => {
    let reads = 0;
    const readMode = async () => { reads++; return 'own'; };
    expect(await kernelMode({ host: () => 'web', env: { EXECUTION_MODE: 'own' }, readMode })).toBe('own');
    expect(await kernelMode({ host: () => 'web', env: { EXECUTION_MODE: 'shadow', VERCEL: '1' }, readMode })).toBe('shadow');
    expect(await kernelMode({ host: () => 'web', env: {}, readMode })).toBe('shadow');
    expect(reads).toBe(0);
  });

  it('on Vercel: follows the Worker\'s reported mode, cached; a failed re-read keeps a recent reading; no reading at all is own', async () => {
    let t = 0;
    let reported: string | null = 'shadow';
    let reads = 0;
    const deps: ClientDeps = { host: () => 'web', env: { VERCEL: '1' }, now: () => t, readMode: async () => { reads++; return reported; } };
    expect(await kernelMode(deps)).toBe('shadow');
    reported = 'own';
    t += MODE_FRESH_MS - 1;
    expect(await kernelMode(deps)).toBe('shadow');
    expect(reads).toBe(1);
    t += 2;
    expect(await kernelMode(deps)).toBe('own');
    reported = null;
    t += MODE_FRESH_MS + 1;
    expect(await kernelMode(deps)).toBe('own');
    t += MODE_STALE_MS;
    resetKernelModeCache();
    expect(await kernelMode(deps)).toBe('own');
    reported = null;
    resetKernelModeCache();
    expect(await kernelMode({ ...deps, readMode: async () => { throw new Error('down'); } })).toBe('own');
  });
});

describe('in shadow the web host runs the package itself, as before', () => {
  it('no request to the control plane', async () => {
    const l = local();
    let fetched = 0;
    const a = await submitKernelCommand('land', input, { principal, deps: { ...l.deps, env: { EXECUTION_MODE: 'shadow' }, fetch: (async () => { fetched++; return answer(); }) as unknown as typeof fetch } });
    expect(l.ran).toEqual(['land']);
    expect(fetched).toBe(0);
    expect(a).toMatchObject({ result: { where: 'here' }, delivery: { id: DELIVERY, version: 4 }, host: 'web', replayed: false });
  });
});

describe('in own mode the web host submits and applies nothing itself', () => {
  it('a signed POST to the control plane\'s /v1/commands with the principal and key; the answer is the control plane\'s', async () => {
    const l = local();
    const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const a = await submitKernelCommand('land', input, {
      principal, idempotencyKey: 'land:door-key-1',
      deps: { ...l.deps, env: OWN, fetch: (async (url: string, init: RequestInit) => { seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }); return answer(); }) as unknown as typeof fetch },
    });
    expect(l.ran).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://control-plane.buildd.dev/v1/commands');
    expect(seen[0].headers.get('Dispatch-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0].body).toEqual({ v: 1, op: 'land', input, principal, idempotencyKey: 'land:door-key-1' });
    expect(a).toMatchObject({ result: { where: 'control-plane' }, delivery: { version: 5 }, host: 'control-plane', idempotencyKey: 'land:door-key-1' });
  });

  it('AC-12: the control plane unreachable → a retryable error naming the control plane, and nothing applied here', async () => {
    const l = local();
    let attempts = 0;
    let t = 0;
    const err = await submitKernelCommand('land', input, {
      principal, budgetMs: 3_000,
      deps: { ...l.deps, env: OWN, now: () => t, sleep: async (ms) => { t += ms + 500; }, fetch: (async () => { attempts++; throw new TypeError('fetch failed'); }) as unknown as typeof fetch },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('control plane');
    expect(attempts).toBeGreaterThan(1);
    expect(l.ran).toEqual([]);
    const res = controlPlaneUnavailableResponse(err);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toMatchObject({ code: 'control_plane_unavailable', retryable: true, controlPlane: true });
  });

  it('no command key on the web host is the same retryable error, with no request made', async () => {
    const l = local();
    let fetched = 0;
    const err = await submitKernelCommand('land', input, { principal, deps: { ...l.deps, env: { EXECUTION_MODE: 'own' }, fetch: (async () => { fetched++; return answer(); }) as unknown as typeof fetch } }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect([fetched, l.ran.length]).toEqual([0, 0]);
  });

  it('every retry reuses the one idempotency key (a 503, an in_progress, then the answer)', async () => {
    const l = local();
    const keys: string[] = [];
    const replies = [new Response('{}', { status: 503 }), Response.json({ v: 1, code: 'in_progress' }, { status: 409 }), answer({ replayed: true })];
    const a = await submitKernelCommand('land', input, {
      principal,
      deps: { ...l.deps, env: OWN, newKey: () => 'land:made-once', fetch: (async (_u: string, init: RequestInit) => { keys.push(JSON.parse(String(init.body)).idempotencyKey); return replies.shift()!; }) as unknown as typeof fetch },
    });
    expect(keys).toEqual(['land:made-once', 'land:made-once', 'land:made-once']);
    expect(a.replayed).toBe(true);
    expect(l.ran).toEqual([]);
  });

  it('a control plane in shadow answers not_host and the web host runs it after all (nothing was applied there)', async () => {
    const l = local();
    const a = await submitKernelCommand('land', input, { principal, deps: { ...l.deps, env: OWN, fetch: (async () => Response.json({ v: 1, code: 'not_host', mode: 'shadow' }, { status: 409 })) as unknown as typeof fetch } });
    expect(l.ran).toEqual(['land']);
    expect(a.host).toBe('web');
  });

  it('a refusal (bad signature, forbidden) is not retried and is not an outage', async () => {
    const l = local();
    let n = 0;
    const err = await submitKernelCommand('land', input, { principal, deps: { ...l.deps, env: OWN, fetch: (async () => { n++; return Response.json({ v: 1, code: 'forbidden', error: 'no' }, { status: 403 }); }) as unknown as typeof fetch } }).catch((e) => e);
    expect(err).toBeInstanceOf(KernelCommandRefusedError);
    expect([n, l.ran.length]).toEqual([1, 0]);
  });

  it('lockstep false still submits: the Worker on another commit is still the authority', async () => {
    const l = local();
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = String(u instanceof Request ? u.url : u);
      urls.push(url);
      return url.endsWith('/__control-plane/health') ? Response.json({ ok: true, mode: 'own', commit: 'a-different-commit' }) : answer();
    }) as typeof fetch;
    try {
      await submitKernelCommand('land', input, { principal, deps: { ...l.deps, env: { VERCEL: '1', VERCEL_GIT_COMMIT_SHA: 'this-commit', KERNEL_COMMAND_SECRET: 'k1:s3cret' } } });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls).toEqual(['https://control-plane.buildd.dev/__control-plane/health', 'https://control-plane.buildd.dev/v1/commands']);
    expect(l.ran).toEqual([]);
  });
});

describe('the client and the endpoint agree', () => {
  it('a submission signed by the client is accepted by the endpoint and answered once per key', async () => {
    const rows = new Map<string, { status: 'running' | 'done'; response: unknown; token: string; requestHash: string }>();
    const ledger: CommandLedger = {
      claim: async (p) => (rows.has(p.key) ? false : (rows.set(p.key, { status: 'running', response: null, token: p.token, requestHash: p.requestHash }), true)),
      complete: async (p) => { const r = rows.get(p.key)!; r.status = 'done'; r.response = p.response; return true; },
      release: async (p) => { rows.delete(p.key); },
      read: async (k) => { const r = rows.get(k); return r ? { key: k, op: 'land', principal: '', requestHash: r.requestHash, status: r.status, response: r.response as never, claimedAt: '' } : null; },
      prune: async () => 0,
    };
    let runs = 0;
    const endpoint = (url: string, init: RequestInit) => handleCommandRequest(new Request(url, init), {
      env: OWN, host: () => 'control-plane', ledger, reaches: async () => true,
      run: (async () => { runs++; return { merged: true }; }) as never, deliveryAfter: async () => ({ id: DELIVERY, version: 6 }),
    });
    const l = local();
    const opts = { principal, idempotencyKey: 'land:shared-key', deps: { ...l.deps, env: OWN, fetch: endpoint as unknown as typeof fetch } };
    const a = await submitKernelCommand('land', input, opts);
    const b = await submitKernelCommand('land', input, opts);
    expect(runs).toBe(1);
    expect([a.replayed, b.replayed]).toEqual([false, true]);
    expect(a.result).toEqual(b.result);
    expect(a.delivery).toEqual({ id: DELIVERY, version: 6 });
    expect(l.ran).toEqual([]);
  });
});
