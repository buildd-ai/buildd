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

/** Node's fetch when the connection is refused: `fetch failed` with the socket error as its cause. */
const refusedErr = (code = 'ECONNREFUSED') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

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
  it('on the control plane: its own EXECUTION_MODE, and only with the command key', async () => {
    expect(await kernelMode({ host: () => 'control-plane', env: OWN })).toBe('own');
    expect(await kernelMode({ host: () => 'control-plane', env: { EXECUTION_MODE: 'own' } })).toBe('shadow');
    expect(await kernelMode({ host: () => 'control-plane', env: {} })).toBe('shadow');
  });

  it('on the web host with no KERNEL_COMMAND_SECRET: shadow, whatever either host\'s mode, and the Worker is not even asked', async () => {
    let reads = 0;
    const readMode = async () => { reads++; return 'own'; };
    for (const env of [{ EXECUTION_MODE: 'own' }, { VERCEL: '1' }, { VERCEL: '1', EXECUTION_MODE: 'own', CRON_SECRET: 'c' }]) {
      expect(await kernelMode({ host: () => 'web', env, readMode })).toBe('shadow');
    }
    expect(reads).toBe(0);
  });

  it('on the web host: an explicit EXECUTION_MODE wins; off Vercel with none it is shadow and reads nothing', async () => {
    let reads = 0;
    const readMode = async () => { reads++; return 'own'; };
    expect(await kernelMode({ host: () => 'web', env: OWN, readMode })).toBe('own');
    expect(await kernelMode({ host: () => 'web', env: { ...OWN, EXECUTION_MODE: 'shadow', VERCEL: '1' }, readMode })).toBe('shadow');
    expect(await kernelMode({ host: () => 'web', env: { KERNEL_COMMAND_SECRET: 'k1:s3cret' }, readMode })).toBe('shadow');
    expect(reads).toBe(0);
  });

  it('a cached reading older than the stale bound plus a failed re-read is own, never the old reading', async () => {
    let t = 0;
    let reported: string | null = 'shadow';
    const deps: ClientDeps = { host: () => 'web', env: { VERCEL: '1', KERNEL_COMMAND_SECRET: 'k1:s3cret' }, now: () => t, readMode: async () => reported };
    expect(await kernelMode(deps)).toBe('shadow');
    reported = null;
    t = MODE_STALE_MS - 1;
    expect(await kernelMode(deps)).toBe('shadow');
    t = MODE_STALE_MS + 1;
    expect(await kernelMode(deps)).toBe('own');
  });

  it('on Vercel: follows the Worker\'s reported mode, cached; a failed re-read keeps a recent reading; no reading at all is own', async () => {
    let t = 0;
    let reported: string | null = 'shadow';
    let reads = 0;
    const deps: ClientDeps = { host: () => 'web', env: { VERCEL: '1', KERNEL_COMMAND_SECRET: 'k1:s3cret' }, now: () => t, readMode: async () => { reads++; return reported; } };
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
      deps: { ...l.deps, env: OWN, now: () => t, sleep: async (ms) => { t += ms + 500; }, fetch: (async () => { attempts++; throw refusedErr(); }) as unknown as typeof fetch },
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

  it('no KERNEL_COMMAND_SECRET on the web host: the command runs here, exactly as before, and nothing is submitted', async () => {
    const l = local();
    let fetched = 0;
    const a = await submitKernelCommand('land', input, { principal, deps: { ...l.deps, env: { EXECUTION_MODE: 'own', VERCEL: '1', CRON_SECRET: 'c' }, fetch: (async () => { fetched++; return answer(); }) as unknown as typeof fetch } });
    expect(fetched).toBe(0);
    expect(l.ran).toEqual(['land']);
    expect(a.host).toBe('web');
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

  it('half switched over: a control plane with no command key answers 503 unconfigured, and the web host runs it at once (nothing was applied there)', async () => {
    const l = local();
    let n = 0;
    const a = await submitKernelCommand('land', input, { principal, deps: { ...l.deps, env: OWN, fetch: (async () => { n++; return Response.json({ v: 1, code: 'unconfigured', retryable: true }, { status: 503 }); }) as unknown as typeof fetch } });
    expect(n).toBe(1);
    expect(l.ran).toEqual(['land']);
    expect(a.host).toBe('web');
  });

  it('the Worker\'s health is read for `kernel`, not `mode`: own execution routes without a command key read shadow, and a Worker without the field is not switched over', async () => {
    const { readWorkerMode } = await import('./kernel-client');
    const realFetch = globalThis.fetch;
    const replies = [{ mode: 'own', kernel: 'shadow' }, { mode: 'own', kernel: 'own' }, { mode: 'own' }];
    globalThis.fetch = (async () => Response.json(replies.shift())) as unknown as typeof fetch;
    try {
      expect([await readWorkerMode({}), await readWorkerMode({}), await readWorkerMode({})]).toEqual(['shadow', 'own', 'shadow']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('a failure before any request reached the control plane is not_applied; one after a request may have reached it is unknown and carries the key to retry with', async () => {
    const run = async (fetchImpl: () => Promise<Response>) => {
      const l = local();
      let t = 0;
      const err = await submitKernelCommand('land', input, {
        principal, idempotencyKey: 'land:the-one-key', budgetMs: 3_000,
        deps: { ...l.deps, env: OWN, now: () => t, sleep: async (ms) => { t += ms + 500; }, fetch: fetchImpl as unknown as typeof fetch },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
      expect(l.ran).toEqual([]);
      return err as InstanceType<typeof ControlPlaneUnavailableError>;
    };
    const refused = await run(async () => { throw refusedErr(); });
    expect(refused.outcome).toBe('not_applied');
    expect(refused.message).toContain('nothing was applied');
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) expect((await run(async () => { throw refusedErr(code); })).outcome).toBe('not_applied');
    // Node reports a connection reset after the body was sent as the same `fetch failed`: it may have run.
    const reset = await run(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }); });
    expect(reset.outcome).toBe('unknown');
    expect((await run(async () => { throw new TypeError('fetch failed'); })).outcome).toBe('unknown');
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    for (const unknown of [
      await run(async () => { throw timeout; }),
      await run(async () => Response.json({ v: 1, code: 'in_progress' }, { status: 409 })),
      await run(async () => new Response('bad gateway', { status: 502 })),
    ]) {
      expect(unknown.outcome).toBe('unknown');
      expect(unknown.idempotencyKey).toBe('land:the-one-key');
      expect(unknown.message).not.toContain('nothing was applied');
      expect(unknown.message).toContain('land:the-one-key');
      const body = await controlPlaneUnavailableResponse(unknown).json();
      expect(body).toMatchObject({ outcome: 'unknown', idempotencyKey: 'land:the-one-key', retryable: true });
    }
    // The key is in every unavailable answer, so the caller can always retry with it.
    expect(await controlPlaneUnavailableResponse(refused).json()).toMatchObject({ outcome: 'not_applied', idempotencyKey: 'land:the-one-key' });
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
      return url.endsWith('/__control-plane/health') ? Response.json({ ok: true, mode: 'own', kernel: 'own', commit: 'a-different-commit' }) : answer();
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

describe('the doors\' functions', () => {
  it('read the principal off the actor: a person by id, anything else a named system principal', async () => {
    const { principalOfActor } = await import('./kernel-client');
    expect(principalOfActor(`human:${USER}`)).toEqual({ kind: 'user', id: USER });
    expect(principalOfActor('human:not-a-uuid')).toEqual({ kind: 'system', id: 'human:not-a-uuid' });
    expect(principalOfActor('agent:w-1')).toEqual({ kind: 'system', id: 'agent:w-1' });
    expect(principalOfActor(undefined)).toEqual({ kind: 'system', id: 'system:door' });
  });

  it('a door\'s Idempotency-Key header is the command\'s key when it is well formed', async () => {
    const { idempotencyKeyOf } = await import('./kernel-client');
    const req = (v?: string) => new Request('https://x', { headers: v ? { 'Idempotency-Key': v } : {} });
    expect(idempotencyKeyOf(req('merge:click-0001'))).toBe('merge:click-0001');
    expect(idempotencyKeyOf(req('short'))).toBeUndefined();
    expect(idempotencyKeyOf(req('has spaces in it'))).toBeUndefined();
    expect(idempotencyKeyOf(req())).toBeUndefined();
  });

  it('in own mode a door function submits its op with the person as principal and returns the bare result', async () => {
    const { landThroughKernel } = await import('./kernel-client');
    const saved = { ...process.env };
    process.env.EXECUTION_MODE = 'own';
    process.env.KERNEL_COMMAND_SECRET = 'k1:s3cret';
    const realFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer(); }) as unknown as typeof fetch;
    try {
      const r = await landThroughKernel(input, { idempotencyKey: 'land:from-header' });
      expect(r).toEqual({ merged: true, where: 'control-plane' } as never);
      expect(bodies).toEqual([{ v: 1, op: 'land', input, principal: { kind: 'user', id: USER }, idempotencyKey: 'land:from-header' }]);
    } finally {
      globalThis.fetch = realFetch;
      process.env = saved;
    }
  });
});

describe('a door after an unknown outcome', () => {
  it('submits again with the same key and returns the control plane\'s answer; a not_applied failure is not retried', async () => {
    const { landThroughKernel, DOOR_UNKNOWN_RETRIES } = await import('./kernel-client');
    const keys: string[] = [];
    let t = 0;
    // A budget of one attempt per submission, so each unknown outcome reaches the door.
    const base = { env: { ...OWN, KERNEL_COMMAND_BUDGET_MS: '1' }, now: () => t, sleep: async (ms: number) => { t += ms + 10_000; }, newKey: () => 'land:door-call-key', host: () => 'web' as const };
    // Two calls time out (outcome unknown), then the replay of the stored answer arrives.
    const replies: Array<() => Promise<Response>> = [
      async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
      async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
      async () => answer({ replayed: true }),
    ];
    const fetchImpl = (async (_u: string, init: RequestInit) => { keys.push(JSON.parse(String(init.body)).idempotencyKey); return replies.shift()!(); }) as unknown as typeof fetch;
    const r = await landThroughKernel(input, { deps: { ...base, fetch: fetchImpl, run: (async () => { throw new Error('ran locally'); }) as never } });
    expect(r).toEqual({ merged: true, where: 'control-plane' } as never);
    expect(keys).toEqual(['land:door-call-key', 'land:door-call-key', 'land:door-call-key']);
    expect(DOOR_UNKNOWN_RETRIES).toBeGreaterThan(0);

    let refusedCalls = 0;
    const err = await landThroughKernel(input, {
      deps: { ...base, fetch: (async () => { refusedCalls++; throw refusedErr(); }) as unknown as typeof fetch },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(err.outcome).toBe('not_applied');
    const perSubmit = refusedCalls;
    // One submission's own retries only: the door did not start a second submission.
    expect(perSubmit).toBeGreaterThan(0);
    refusedCalls = 0;
    await submitKernelCommand('land', input, { principal, deps: { ...base, fetch: (async () => { refusedCalls++; throw refusedErr(); }) as unknown as typeof fetch } }).catch(() => {});
    expect(perSubmit).toBe(refusedCalls);
  });
});

describe('no local run after an attempt that may have reached the control plane', () => {
  const timeout = () => Object.assign(new Error('t'), { name: 'TimeoutError' });

  it('within one submission: a timeout, then not_host or unconfigured, raises unknown instead of running here', async () => {
    for (const second of [Response.json({ v: 1, code: 'not_host' }, { status: 409 }), Response.json({ v: 1, code: 'unconfigured' }, { status: 503 })]) {
      const l = local();
      const replies: Array<() => Promise<Response>> = [async () => { throw timeout(); }, async () => second];
      const err = await submitKernelCommand('land', input, { principal, idempotencyKey: 'land:k-0001', deps: { ...l.deps, env: OWN, fetch: (async () => replies.shift()!()) as unknown as typeof fetch } }).catch((e) => e);
      expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
      expect(err.outcome).toBe('unknown');
      expect(err.idempotencyKey).toBe('land:k-0001');
      expect(l.ran).toEqual([]);
    }
  });

  it('across a door call: after an unknown submission, a later not_host, unconfigured or shadow reading never runs it here', async () => {
    const { landThroughKernel } = await import('./kernel-client');
    let t = 0;
    const base = { env: { ...OWN, KERNEL_COMMAND_BUDGET_MS: '1' }, now: () => t, sleep: async (ms: number) => { t += ms + 10_000; }, newKey: () => 'land:door-k-0001', host: () => 'web' as const };
    for (const later of [
      async () => Response.json({ v: 1, code: 'not_host' }, { status: 409 }),
      async () => Response.json({ v: 1, code: 'unconfigured' }, { status: 503 }),
    ]) {
      const ran: string[] = [];
      const replies: Array<() => Promise<Response>> = [async () => { throw timeout(); }, later, later, later];
      const err = await landThroughKernel(input, {
        deps: { ...base, fetch: (async () => replies.shift()!()) as unknown as typeof fetch, run: (async (op: string) => { ran.push(op); return {}; }) as never, deliveryAfter: async () => null },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
      expect(err.outcome).toBe('unknown');
      expect(ran).toEqual([]);
    }
    // The submission itself, told an earlier one was unknown, refuses to run here even when the mode now says shadow.
    const ran: string[] = [];
    const err = await submitKernelCommand('land', input, {
      principal, idempotencyKey: 'land:door-k-0002', priorUnknown: true,
      deps: { env: { EXECUTION_MODE: 'shadow', KERNEL_COMMAND_SECRET: 'k1:s3cret' }, host: () => 'web', run: (async (op: string) => { ran.push(op); return {}; }) as never },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(ran).toEqual([]);
  });
});
