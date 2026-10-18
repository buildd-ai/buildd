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

afterEach(async () => {
  resetKernelModeCache();
  (await import('./kernel-client')).resetAttemptStartBreaker();
});

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

describe('the mode read under a sweep\'s load (incident 197552dc)', () => {
  it('concurrent callers share one health read, and a failed read is not repeated for a few seconds', async () => {
    let t = 0;
    let reads = 0;
    let answer: string | null = null;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const deps: ClientDeps = { host: () => 'web', env: { VERCEL: '1', KERNEL_COMMAND_SECRET: 'k1:s3cret' }, now: () => t, readMode: async () => { reads++; await gate; return answer; } };
    // Thirteen sweeps start at once on a cold cache: one read, not thirteen.
    const all = Promise.all(Array.from({ length: 13 }, () => kernelMode(deps)));
    open();
    expect(await all).toEqual(Array(13).fill('own'));
    expect(reads).toBe(1);
    // The health did not answer: the next calls within the retry window do not wait on it again.
    // Literals, not the constant: the window is pinned at 5 s.
    t += 4_999;
    expect(await kernelMode(deps)).toBe('own');
    expect(reads).toBe(1);
    t += 2;
    answer = 'shadow';
    expect(await kernelMode(deps)).toBe('shadow');
    expect(reads).toBe(2);
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
      renew: async (p) => rows.get(p.key)?.token === p.token,
      complete: async (p) => { const r = rows.get(p.key)!; r.status = 'done'; r.response = p.response; return true; },
      release: async (p) => { rows.delete(p.key); },
      read: async (k) => { const r = rows.get(k); return r ? { key: k, op: 'land', principal: '', requestHash: r.requestHash, status: r.status, response: r.response as never, claimedAt: '' } : null; },
      prune: async () => 0,
    };
    let runs = 0;
    const endpoint = (url: string, init: RequestInit) => handleCommandRequest(new Request(url, init), {
      env: OWN, host: () => 'control-plane', ledger, reaches: async () => true, installationOf: async () => ({ installationId: 1 }),
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
  it('read the principal off the actor: a person by id, buildd\'s own actors the system, an agent run or a malformed person nothing', async () => {
    const { principalOfActor } = await import('./kernel-client');
    expect(principalOfActor(`human:${USER}`)).toEqual({ kind: 'user', id: USER });
    expect(principalOfActor('system:auto_merge')).toEqual({ kind: 'system', id: 'system:auto_merge' });
    expect(principalOfActor('rule:escalation_gate')).toEqual({ kind: 'system', id: 'rule:escalation_gate' });
    expect(principalOfActor('buildd:recovery')).toEqual({ kind: 'system', id: 'buildd:recovery' });
    expect(principalOfActor(undefined)).toEqual({ kind: 'system', id: 'system:door' });
    // Never the system: an agent run, a person with no valid id, a free-text label.
    for (const a of ['agent:w-1', 'human:not-a-uuid', 'human:unknown', 'my-api-key', '']) expect(principalOfActor(a)).toBeNull();
  });

  it('a door names its authenticated caller: a grant session as its grant, whoever is behind it', async () => {
    const { kernelPrincipalOf } = await import('./kernel-client');
    const ACCT = '44444444-4444-4444-8444-444444444444';
    const grant = { id: ACCT, oauthGrantId: 'g-1', grantScopes: ['read', 'write'], workspaceIds: [WS] };
    const asGrant = { kind: 'grant', id: ACCT, grantId: 'g-1', workspaceIds: [WS], scopes: ['read', 'write'] };
    expect(kernelPrincipalOf({ account: grant })).toEqual(asGrant);
    expect(kernelPrincipalOf({ account: grant, person: USER })).toEqual({ ...asGrant, userId: USER });
    // A grant with no list reaches nothing, and says so.
    expect(kernelPrincipalOf({ account: { ...grant, workspaceIds: null } })).toMatchObject({ kind: 'grant', workspaceIds: [] });
    expect(kernelPrincipalOf({ person: USER, account: { id: ACCT, oauthGrantId: null } })).toEqual({ kind: 'user', id: USER });
    expect(kernelPrincipalOf({ account: { id: ACCT } })).toEqual({ kind: 'account', id: ACCT, grant: null });
    expect(kernelPrincipalOf({ person: USER })).toEqual({ kind: 'user', id: USER });
    expect(kernelPrincipalOf({})).toBeNull();
  });

  it('a sweep is the system only when its actor names buildd; a caller is named by its session', async () => {
    const { doorPrincipal } = await import('./kernel-client');
    expect(doorPrincipal('system', 'system:auto-supersession')).toEqual({ kind: 'system', id: 'system:auto-supersession' });
    for (const a of ['agent:t-1', 'human:not-a-uuid', 'my-api-key', '', undefined]) expect(doorPrincipal('system', a)).toBeNull();
    expect(doorPrincipal({ person: USER }, 'agent:t-1')).toEqual({ kind: 'user', id: USER });
  });

  it('a command with no principal is never sent to the control plane: refused, nothing applied anywhere', async () => {
    const l = local();
    let sent = 0;
    const err = await submitKernelCommand('land', { ...input, actor: 'agent:w-1' }, {
      principal: null,
      deps: { ...l.deps, env: OWN, fetch: (async () => { sent++; return answer(); }) as unknown as typeof fetch },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(KernelCommandRefusedError);
    expect(err.body.code).toBe('no_principal');
    expect([sent, l.ran]).toEqual([0, []]);
  });

  it('an explicit null principal stays null: a system-actor door is not sent as the system for a caller that named none', async () => {
    const { openKernelDelivery, policyMergeThroughKernel } = await import('./kernel-client');
    const l = local();
    let sent = 0;
    const deps = { ...l.deps, env: OWN, fetch: (async () => { sent++; return answer(); }) as unknown as typeof fetch };
    const open = await openKernelDelivery({ workspaceId: WS, ownerTaskId: 't', repoFullName: 'acme/w', prNumber: 7, installationId: 1, source: 'create_pr' } as never, { principal: null, deps }).catch((e) => e);
    expect(open).toBeInstanceOf(KernelCommandRefusedError);
    expect(open.body.code).toBe('no_principal');
    const merge = await policyMergeThroughKernel({ workspaceId: WS, prNumber: 7, headSha: 'H1', reason: 'r' } as never, { principal: null, deps }).catch((e) => e);
    expect(merge).toBeInstanceOf(KernelCommandRefusedError);
    expect([sent, l.ran]).toEqual([0, []]);
    // A sweep names itself explicitly as the system.
    const { systemPrincipal } = await import('./kernel-client');
    await openKernelDelivery({ workspaceId: WS, ownerTaskId: 't', repoFullName: 'acme/w', prNumber: 7, installationId: 1, source: 'webhook:opened' } as never, { principal: systemPrincipal('system:webhook:opened'), deps });
    expect(sent).toBe(1);
  });

  it('an agent-run door with no principal of its own fails closed instead of submitting as the system', async () => {
    const { landThroughKernel } = await import('./kernel-client');
    const l = local();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer(); }) as unknown as typeof fetch;
    const err = await landThroughKernel({ ...input, actor: 'agent:w-1' } as never, { principal: null, deps: { ...l.deps, env: OWN, fetch: fetchSpy } }).catch((e) => e);
    expect(err).toBeInstanceOf(KernelCommandRefusedError);
    expect(bodies).toEqual([]);
    // In shadow the web host runs it itself, as before: the principal is the control plane's check only.
    const shadow = local();
    await landThroughKernel({ ...input, actor: 'agent:w-1' } as never, { principal: null, deps: { ...shadow.deps, env: {} } });
    expect(shadow.ran).toEqual(['land']);
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
      const r = await landThroughKernel(input, { principal, idempotencyKey: 'land:from-header' });
      expect(r).toEqual({ merged: true, where: 'control-plane' } as never);
      expect(bodies).toEqual([{ v: 1, op: 'land', input, principal: { kind: 'user', id: USER }, idempotencyKey: 'land:from-header' }]);
    } finally {
      globalThis.fetch = realFetch;
      process.env = saved;
    }
  });
});

describe('T4 is a door too (AC-9): an attempt\'s end from the web host', () => {
  const end = {
    task: { id: 't-1', workspaceId: WS, deliveryId: DELIVERY, deliveryRole: 'owner', context: null },
    workerId: 'w-1', status: 'completed' as const, localHeadSha: 'H1', commitCount: 1, source: 'runner',
  };

  it('in own mode it is submitted to the control plane, the task\'s workspace on the input for the reach check, and nothing runs here', async () => {
    const { attemptEnded } = await import('./kernel-client');
    const l = local();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({ op: 'attempt_ended', result: { handled: true } }); }) as unknown as typeof fetch;
    const r = await attemptEnded(end, { principal: { kind: 'account', id: USER, grant: null }, idempotencyKey: 'attempt_ended:k-0001', deps: { ...l.deps, env: OWN, fetch: fetchSpy } });
    expect(r).toEqual({ handled: true });
    expect(l.ran).toEqual([]);
    expect(bodies).toEqual([{ v: 1, op: 'attempt_ended', input: { ...end, workspaceId: WS }, principal: { kind: 'account', id: USER, grant: null }, idempotencyKey: 'attempt_ended:k-0001' }]);
  });

  it('in shadow the web host runs it itself, as before', async () => {
    const { attemptEnded, systemPrincipal } = await import('./kernel-client');
    const l = local();
    await attemptEnded(end, { principal: systemPrincipal('system:sweep:stale-workers'), deps: { ...l.deps, env: {} } });
    expect(l.ran).toEqual(['attempt_ended']);
  });

  it('release skew: a control plane that does not know the op (it predates it) refused it, so the web host applies it itself', async () => {
    const { attemptEnded } = await import('./kernel-client');
    const l = local();
    let sent = 0;
    // What an older control plane answers for an op it does not know: commandProblem's refusal, verbatim.
    const { commandProblem } = await import('./command-api');
    const why = commandProblem({ v: 1, op: 'attempt_ended_from_the_future', idempotencyKey: 'k-00000001', principal, input: { workspaceId: WS } })!;
    expect(why).toBe('unknown op "attempt_ended_from_the_future"');
    const older = (async () => { sent++; return Response.json({ v: 1, code: 'bad_request', error: why.replace('attempt_ended_from_the_future', 'attempt_ended') }, { status: 400 }); }) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      await attemptEnded(end, { principal: { kind: 'account', id: USER, grant: null }, deps: { ...l.deps, env: OWN, fetch: older } });
    } finally {
      console.error = realError;
    }
    expect(sent).toBe(1);
    expect(l.ran).toEqual(['attempt_ended']);
    expect(String(errors[0])).toContain('SKEW');
  });

  it('release skew only: any other refusal (forbidden, a malformed input) stays a refusal and nothing runs here', async () => {
    const { attemptEnded, refusedAsUnknownOp } = await import('./kernel-client');
    for (const [status, code, error] of [[403, 'forbidden', 'account does not reach this workspace'], [400, 'bad_request', 'input.workspaceId must be a uuid'], [400, 'bad_request', 'unknown op "land"']] as const) {
      const l = local();
      const refusing = (async () => Response.json({ v: 1, code, error }, { status })) as unknown as typeof fetch;
      const err = await attemptEnded(end, { principal: { kind: 'account', id: USER, grant: null }, deps: { ...l.deps, env: OWN, fetch: refusing } }).catch((e) => e);
      expect(err).toBeInstanceOf(KernelCommandRefusedError);
      expect(refusedAsUnknownOp(err, 'attempt_ended')).toBe(false);
      expect(l.ran).toEqual([]);
    }
  });

  it('the host applies an end only for a task of the workspace the reach check judged', async () => {
    const { runKernelOp } = await import('./command-api');
    const OTHER = '44444444-4444-4444-8444-444444444444';
    await expect(runKernelOp('attempt_ended', { ...end, workspaceId: OTHER })).rejects.toThrow(/not the task's workspace/);
  });
});

describe('AttemptRequeued is a door too (AC-1 slice 6): a requeue from the web host', () => {
  const requeue = {
    task: { id: 't-1', workspaceId: WS, deliveryId: DELIVERY, deliveryRole: 'owner', context: null },
    workerId: 'w-1', reason: 'retry', source: 'runner',
  };
  const runner = { kind: 'account' as const, id: USER, grant: null };

  it('in own mode it is submitted to the control plane, the task\'s workspace on the input, and nothing runs here', async () => {
    const { attemptRequeued } = await import('./kernel-client');
    const l = local();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({ op: 'attempt_requeued', result: { handled: true, requeued: true } }); }) as unknown as typeof fetch;
    const r = await attemptRequeued(requeue, { principal: runner, idempotencyKey: 'attempt_requeued:k-0001', deps: { ...l.deps, env: OWN, fetch: fetchSpy } });
    expect(r).toEqual({ handled: true, requeued: true });
    expect(l.ran).toEqual([]);
    expect(bodies).toEqual([{ v: 1, op: 'attempt_requeued', input: { ...requeue, workspaceId: WS }, principal: runner, idempotencyKey: 'attempt_requeued:k-0001' }]);
  });

  it('in shadow the web host runs it itself', async () => {
    const { attemptRequeued } = await import('./kernel-client');
    const l = local();
    await attemptRequeued(requeue, { principal: runner, deps: { ...l.deps, env: {} } });
    expect(l.ran).toEqual(['attempt_requeued']);
  });

  it('release skew: an older control plane refuses it as unknown, so the web host applies it and says so; any other refusal stays one', async () => {
    const { attemptRequeued } = await import('./kernel-client');
    const l = local();
    const older = (async () => Response.json({ v: 1, code: 'bad_request', error: 'unknown op "attempt_requeued"' }, { status: 400 })) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      await attemptRequeued(requeue, { principal: runner, deps: { ...l.deps, env: OWN, fetch: older } });
    } finally {
      console.error = realError;
    }
    expect(l.ran).toEqual(['attempt_requeued']);
    expect(String(errors[0])).toContain('SKEW');
    const r2 = local();
    const refusing = (async () => Response.json({ v: 1, code: 'forbidden', error: 'account does not reach this workspace' }, { status: 403 })) as unknown as typeof fetch;
    expect(await attemptRequeued(requeue, { principal: runner, deps: { ...r2.deps, env: OWN, fetch: refusing } }).catch((e) => e)).toBeInstanceOf(KernelCommandRefusedError);
    expect(r2.ran).toEqual([]);
  });

  it('the host requeues only a task of the workspace the reach check judged, and the endpoint knows the op', async () => {
    const { runKernelOp, isKernelOp } = await import('./command-api');
    const OTHER = '44444444-4444-4444-8444-444444444444';
    await expect(runKernelOp('attempt_requeued', { ...requeue, workspaceId: OTHER })).rejects.toThrow(/not the task's workspace/);
    expect(isKernelOp('attempt_requeued')).toBe(true);
  });
});

describe('AttemptStarted is a door too (AC-1 slice 7): a claim of a kernel owner task from the web host', () => {
  const start = {
    task: { id: 't-1', workspaceId: WS, deliveryId: DELIVERY, deliveryRole: 'owner', context: null },
    claimedBy: USER, claimedAt: '2026-10-18 08:00:00.123456+00', source: 'claim',
  };
  const runner = { kind: 'account' as const, id: USER, grant: null };

  it('in own mode it is submitted to the control plane, the task\'s workspace on the input, and nothing runs here', async () => {
    const { attemptStarted } = await import('./kernel-client');
    const l = local();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({ op: 'attempt_started', result: { handled: true, started: true } }); }) as unknown as typeof fetch;
    const r = await attemptStarted(start, { principal: runner, idempotencyKey: 'attempt_started:k-0001', deps: { ...l.deps, env: OWN, fetch: fetchSpy } });
    expect(r).toEqual({ handled: true, started: true });
    expect(l.ran).toEqual([]);
    expect(bodies).toEqual([{ v: 1, op: 'attempt_started', input: { ...start, workspaceId: WS }, principal: runner, idempotencyKey: 'attempt_started:k-0001' }]);
  });

  it('in shadow the web host runs it itself', async () => {
    const { attemptStarted } = await import('./kernel-client');
    const l = local();
    await attemptStarted(start, { principal: runner, deps: { ...l.deps, env: {} } });
    expect(l.ran).toEqual(['attempt_started']);
  });

  it('release skew: an older control plane refuses it as unknown, and the web host still never runs it (the claim projects the start instead)', async () => {
    const { attemptStarted } = await import('./kernel-client');
    const l = local();
    const older = (async () => Response.json({ v: 1, code: 'bad_request', error: 'unknown op "attempt_started"' }, { status: 400 })) as unknown as typeof fetch;
    expect(await attemptStarted(start, { principal: runner, deps: { ...l.deps, env: OWN, fetch: older } }).catch((e) => e)).toBeInstanceOf(KernelCommandRefusedError);
    expect(l.ran).toEqual([]);
    const r2 = local();
    const refusing = (async () => Response.json({ v: 1, code: 'forbidden', error: 'account does not reach this workspace' }, { status: 403 })) as unknown as typeof fetch;
    expect(await attemptStarted(start, { principal: runner, deps: { ...r2.deps, env: OWN, fetch: refusing } }).catch((e) => e)).toBeInstanceOf(KernelCommandRefusedError);
    expect(r2.ran).toEqual([]);
  });

  it('its own small budget at the default: a control plane answering 503, or hanging, costs a start well under a second and a half, not the claim\'s 5 s', async () => {
    const { attemptStarted, resetAttemptStartBreaker, ATTEMPT_START_BUDGET_MS } = await import('./kernel-client');
    expect(ATTEMPT_START_BUDGET_MS).toBeLessThanOrEqual(1_000);
    const unavailable = (async () => Response.json({ v: 1, code: 'unavailable' }, { status: 503 })) as unknown as typeof fetch;
    const hanging = ((_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal?.addEventListener('abort', () => rej(init.signal!.reason)); })) as unknown as typeof fetch;
    for (const f of [unavailable, hanging]) {
      resetAttemptStartBreaker();
      const t0 = Date.now();
      const err = await attemptStarted(start, { principal: runner, deps: { ...local().deps, sleep: undefined, env: OWN, fetch: f } }).catch((e) => e);
      expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
      expect(Date.now() - t0).toBeLessThan(1_500);
    }
  });

  it('a start left unanswered opens a short breaker: the next starts skip the door at once, until it closes', async () => {
    const { attemptStarted, resetAttemptStartBreaker, ATTEMPT_START_SKIP_MS } = await import('./kernel-client');
    expect(ATTEMPT_START_SKIP_MS).toBeGreaterThanOrEqual(30_000);
    expect(ATTEMPT_START_SKIP_MS).toBeLessThanOrEqual(60_000);
    resetAttemptStartBreaker();
    let t = 1_000_000;
    let sent = 0;
    const down = (async () => { sent++; throw refusedErr(); }) as unknown as typeof fetch;
    const deps = { ...local().deps, env: OWN, fetch: down, now: () => t, sleep: async (ms: number) => { t += ms + 5_000; } };
    expect(await attemptStarted(start, { principal: runner, deps }).catch((e) => e)).toBeInstanceOf(ControlPlaneUnavailableError);
    const afterFirst = sent;
    expect(afterFirst).toBeGreaterThan(0);
    const skipped = await attemptStarted(start, { principal: runner, deps }).catch((e) => e);
    expect(skipped).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(sent).toBe(afterFirst);
    t += ATTEMPT_START_SKIP_MS + 1;
    const answered = (async () => answer({ op: 'attempt_started', result: { handled: true, started: true } })) as unknown as typeof fetch;
    expect(await attemptStarted(start, { principal: runner, deps: { ...deps, fetch: answered } })).toEqual({ handled: true, started: true });
    resetAttemptStartBreaker();
  });

  it('the door itself never parks a start (the claim route parks what it projected, after its response)', async () => {
    const { attemptStarted } = await import('./kernel-client');
    const l = local();
    const down = (async () => { throw refusedErr(); }) as unknown as typeof fetch;
    let t = 0;
    const parked: unknown[] = [];
    const err = await attemptStarted(start, {
      principal: runner,
      deps: { ...l.deps, env: OWN, fetch: down, now: () => t, sleep: async (ms: number) => { t += ms + 5_000; }, park: (async (p: unknown) => { parked.push(p); return true; }) as never },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(err.parked).not.toBe(true);
    expect(parked).toEqual([]);
    expect(l.ran).toEqual([]);
  });

  it('its retry sleeps are cut to the start deadline: a hang or refusal never overruns the budget by a backoff', async () => {
    const { attemptStarted, resetAttemptStartBreaker } = await import('./kernel-client');
    resetAttemptStartBreaker();
    let t = 0;
    const slept: number[] = [];
    const down = (async () => { throw refusedErr(); }) as unknown as typeof fetch;
    const err = await attemptStarted(start, { principal: runner, deps: { ...local().deps, env: { ...OWN, KERNEL_START_BUDGET_MS: '300' }, fetch: down, now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; } } }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(t).toBeLessThanOrEqual(300);
    expect(slept.every((ms) => ms <= 300)).toBe(true);
    resetAttemptStartBreaker();
  });

  it('a start projected without a kernel answer is parked under one key per claim, valid as a command key', async () => {
    const { parkAttemptStart, attemptStartKey } = await import('./kernel-client');
    const key = attemptStartKey('t-1', '2026-10-18 08:00:00.123456+00');
    expect(key).toMatch(/^[A-Za-z0-9:._-]{8,200}$/);
    expect(key).toBe(attemptStartKey('t-1', '2026-10-18 08:00:00.123456+00'));
    const parked: Array<Record<string, unknown>> = [];
    const ok = await parkAttemptStart({ input: start, principal: runner, why: 'x' }, { park: (async (p: Record<string, unknown>) => { parked.push(p); return true; }) as never });
    expect(ok).toBe(true);
    expect(parked[0]).toMatchObject({ key, op: 'attempt_started', input: { ...start, workspaceId: WS }, principal: runner });
    expect(await parkAttemptStart({ input: start, principal: null, why: 'x' })).toBe(false);
  });

  it('the host starts only a task of the workspace the reach check judged, and the endpoint knows the op', async () => {
    const { runKernelOp, isKernelOp } = await import('./command-api');
    const OTHER = '44444444-4444-4444-8444-444444444444';
    await expect(runKernelOp('attempt_started', { ...start, workspaceId: OTHER })).rejects.toThrow(/not the task's workspace/);
    expect(isKernelOp('attempt_started')).toBe(true);
  });
});

describe('AttemptReopened and AttemptWithdrawn are doors too (AC-1 slice 9)', () => {
  const task = { id: 't-1', workspaceId: WS, deliveryId: DELIVERY, deliveryRole: 'owner', context: null };
  const reopen = { task, workerId: 'w-1', endedAt: '2026-10-18T08:00:00.000Z', to: 'pending' as const, reason: 'credential_restored', source: 'credential-recovery' };
  const withdraw = { task, claim: { claimedBy: USER, claimedAt: '2026-10-18 08:00:00.123456+00' }, outcome: 'requeued' as const, reason: 'claim_rollback', source: 'claim' };
  const runner = { kind: 'account' as const, id: USER, grant: null };
  const ops = [
    ['attempt_reopened', async (deps: never) => (await import('./kernel-client')).attemptReopened(reopen, { principal: runner, deps }), reopen],
    ['attempt_withdrawn', async (deps: never) => (await import('./kernel-client')).attemptWithdrawn(withdraw, { principal: runner, deps }), withdraw],
  ] as const;

  for (const [op, call, input] of ops) {
    it(`${op}: in own mode it is submitted with the task's workspace on the input, and nothing runs here`, async () => {
      (await import('./kernel-client')).resetAttemptStartBreaker();
      const l = local();
      const bodies: Array<Record<string, unknown>> = [];
      const fetchSpy = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({ op, result: { handled: true } }); }) as unknown as typeof fetch;
      await call({ ...l.deps, env: OWN, fetch: fetchSpy } as never);
      expect(l.ran).toEqual([]);
      expect(bodies[0]).toMatchObject({ op, input: { ...input, workspaceId: WS } });
    });

    it(`${op}: in shadow the web host runs it itself`, async () => {
      const l = local();
      await call({ ...l.deps, env: {} } as never);
      expect(l.ran).toEqual([op]);
    });

    it(`${op}: release skew is one more door error: an older control plane refuses it and the web host never runs it, and nothing parks`, async () => {
      (await import('./kernel-client')).resetAttemptStartBreaker();
      const l = local();
      const parked: unknown[] = [];
      const older = (async () => Response.json({ v: 1, code: 'bad_request', error: `unknown op "${op}"` }, { status: 400 })) as unknown as typeof fetch;
      expect(await call({ ...l.deps, env: OWN, fetch: older, park: (async (p: unknown) => { parked.push(p); return true; }) } as never).catch((e) => e)).toBeInstanceOf(KernelCommandRefusedError);
      let t = 0;
      const down = (async () => { throw refusedErr(); }) as unknown as typeof fetch;
      const err = await call({ ...l.deps, env: OWN, fetch: down, now: () => t, sleep: async (ms: number) => { t += ms + 5_000; }, park: (async (p: unknown) => { parked.push(p); return true; }) } as never).catch((e) => e);
      expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
      expect({ ran: l.ran, parked }).toEqual({ ran: [], parked: [] });
      (await import('./kernel-client')).resetAttemptStartBreaker();
    });

    it(`${op}: the host moves only a task of the workspace the reach check judged, and the endpoint knows the op`, async () => {
      const { runKernelOp, isKernelOp } = await import('./command-api');
      await expect(runKernelOp(op, { ...input, workspaceId: '44444444-4444-4444-8444-444444444444' } as never)).rejects.toThrow(/not the task's workspace/);
      expect(isKernelOp(op)).toBe(true);
    });
  }
});

describe('T10 from a sweep is a door too (AC-9): the CI-red sweep\'s and the landing path\'s CI failure', () => {
  const seen = { workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, installationId: 1, headSha: 'H1', signature: 'ci_failed', maxAttempts: 3, source: 'cron:ci-red' };
  const sweep = { kind: 'system' as const, id: 'system:cron:ci-red' };

  it('in own mode it is submitted to the control plane as buildd\'s own sweep, and nothing runs here', async () => {
    const { observeCiFailure } = await import('./kernel-client');
    const l = local();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({ op: 'observe_ci_failure', result: { handled: false } }); }) as unknown as typeof fetch;
    const r = await observeCiFailure(seen, { principal: sweep, idempotencyKey: 'observe_ci_failure:k-0001', deps: { ...l.deps, env: OWN, fetch: fetchSpy } });
    expect(r).toEqual({ handled: false });
    expect(l.ran).toEqual([]);
    expect(bodies).toEqual([{ v: 1, op: 'observe_ci_failure', input: seen, principal: sweep, idempotencyKey: 'observe_ci_failure:k-0001' }]);
  });

  it('in shadow the web host runs it itself, as before', async () => {
    const { observeCiFailure } = await import('./kernel-client');
    const l = local();
    await observeCiFailure({ ...seen, source: 'landing' }, { principal: { kind: 'system', id: 'system:landing' }, deps: { ...l.deps, env: {} } });
    expect(l.ran).toEqual(['observe_ci_failure']);
  });

  it('release skew: a control plane that predates the op refused it as unknown, so the web host applies it itself and says so', async () => {
    const { observeCiFailure } = await import('./kernel-client');
    const l = local();
    const older = (async () => Response.json({ v: 1, code: 'bad_request', error: 'unknown op "observe_ci_failure"' }, { status: 400 })) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      await observeCiFailure(seen, { principal: sweep, deps: { ...l.deps, env: OWN, fetch: older } });
    } finally {
      console.error = realError;
    }
    expect(l.ran).toEqual(['observe_ci_failure']);
    expect(String(errors[0])).toContain('SKEW');
    expect(String(errors[0])).toContain('observe_ci_failure');
  });

  it('release skew only: any other refusal stays a refusal and nothing runs here', async () => {
    const { observeCiFailure } = await import('./kernel-client');
    for (const [status, code, error] of [[403, 'forbidden', 'principal refused'], [400, 'bad_request', 'unknown op "land"']] as const) {
      const l = local();
      const refusing = (async () => Response.json({ v: 1, code, error }, { status })) as unknown as typeof fetch;
      const err = await observeCiFailure(seen, { principal: sweep, deps: { ...l.deps, env: OWN, fetch: refusing } }).catch((e) => e);
      expect(err).toBeInstanceOf(KernelCommandRefusedError);
      expect(l.ran).toEqual([]);
    }
  });

  it('the command endpoint knows the op', async () => {
    const { isKernelOp } = await import('./command-api');
    expect(isKernelOp('observe_ci_failure')).toBe(true);
  });
});

describe('a green head from the check_suite webhook is a door too (AC-9): CiGreenObserved, or a CiObserved reading', () => {
  const green = { workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, installationId: 1, headSha: 'H1', source: 'webhook:check_suite' };
  const webhook = { kind: 'system' as const, id: 'system:webhook:check_suite' };

  it('in own mode it is submitted to the control plane as buildd\'s own webhook, and nothing runs here', async () => {
    const { observeCiGreen } = await import('./kernel-client');
    const l = local();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({ op: 'observe_ci_green', result: { handled: false } }); }) as unknown as typeof fetch;
    const r = await observeCiGreen(green, { principal: webhook, idempotencyKey: 'observe_ci_green:k-0001', deps: { ...l.deps, env: OWN, fetch: fetchSpy } });
    expect(r).toEqual({ handled: false });
    expect(l.ran).toEqual([]);
    expect(bodies).toEqual([{ v: 1, op: 'observe_ci_green', input: green, principal: webhook, idempotencyKey: 'observe_ci_green:k-0001' }]);
  });

  it('in shadow the web host runs it itself, as before', async () => {
    const { observeCiGreen } = await import('./kernel-client');
    const l = local();
    await observeCiGreen(green, { principal: webhook, deps: { ...l.deps, env: {} } });
    expect(l.ran).toEqual(['observe_ci_green']);
  });

  it('release skew: a control plane that predates the op refused it as unknown, so the web host applies it itself and says so', async () => {
    const { observeCiGreen } = await import('./kernel-client');
    const l = local();
    const older = (async () => Response.json({ v: 1, code: 'bad_request', error: 'unknown op "observe_ci_green"' }, { status: 400 })) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      await observeCiGreen(green, { principal: webhook, deps: { ...l.deps, env: OWN, fetch: older } });
    } finally {
      console.error = realError;
    }
    expect(l.ran).toEqual(['observe_ci_green']);
    expect(String(errors[0])).toContain('SKEW');
    expect(String(errors[0])).toContain('observe_ci_green');
  });

  it('release skew only: any other refusal stays a refusal and nothing runs here', async () => {
    const { observeCiGreen } = await import('./kernel-client');
    for (const [status, code, error] of [[403, 'forbidden', 'principal refused'], [400, 'bad_request', 'unknown op "land"']] as const) {
      const l = local();
      const refusing = (async () => Response.json({ v: 1, code, error }, { status })) as unknown as typeof fetch;
      const err = await observeCiGreen(green, { principal: webhook, deps: { ...l.deps, env: OWN, fetch: refusing } }).catch((e) => e);
      expect(err).toBeInstanceOf(KernelCommandRefusedError);
      expect(l.ran).toEqual([]);
    }
  });

  it('the command endpoint knows the op', async () => {
    const { isKernelOp } = await import('./command-api');
    expect(isKernelOp('observe_ci_green')).toBe(true);
  });
});

describe('AC-74: a door command the control plane never answered is parked for the floor, under its own key', () => {
  const end = {
    task: { id: 't-1', workspaceId: WS, deliveryId: DELIVERY, deliveryRole: 'fix', context: { workflowAttemptId: 'a-1' } },
    workerId: 'w-1', status: 'completed' as const, localHeadSha: 'H1', commitCount: 1, source: 'runner',
  };
  const runner = { kind: 'account' as const, id: USER, grant: null };
  const down = (async () => { throw refusedErr(); }) as unknown as typeof fetch;
  /** A clock the door's backoff moves, so a door that never gets an answer runs out its budget at once. */
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms + 5_000; } }; };
  const parker = () => {
    const parked: Array<Record<string, unknown>> = [];
    return { parked, park: async (p: Record<string, unknown>) => { parked.push(p); return true; } };
  };

  it('an attempt end that never got an answer is parked with the door\'s key, op, input and principal, and the door still answers unavailable', async () => {
    const { attemptEnded } = await import('./kernel-client');
    const l = local();
    const k = parker();
    const err = await attemptEnded(end, { principal: runner, idempotencyKey: 'attempt_ended:k-park-1', deps: { ...l.deps, ...clock(), env: OWN, fetch: down, park: k.park as never } }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(err.parked).toBe(true);
    expect(k.parked).toEqual([{ key: 'attempt_ended:k-park-1', op: 'attempt_ended', input: { ...end, workspaceId: WS }, principal: runner, priorUnknown: false, why: err.why }]);
    expect(l.ran).toEqual([]);
  });

  it('an unknown outcome is parked as such, so the floor never runs it on the web host without the ledger\'s word', async () => {
    const { observeCiGreen, systemPrincipal } = await import('./kernel-client');
    const k = parker();
    let t = 0;
    const timeout = (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
    const green = { workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, installationId: 1, headSha: 'H1', source: 'webhook:check_suite' };
    const err = await observeCiGreen(green, {
      principal: systemPrincipal('system:webhook:check_suite'),
      deps: { ...local().deps, env: OWN, fetch: timeout, now: () => t, sleep: async (ms: number) => { t += ms + 5_000; }, park: k.park as never },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(err.outcome).toBe('unknown');
    expect(k.parked).toHaveLength(1);
    expect(k.parked[0]).toMatchObject({ op: 'observe_ci_green', priorUnknown: true, key: err.idempotencyKey });
  });

  it('only ops nothing else re-sends: a landing that got no answer is the caller\'s to retry, and is not parked', async () => {
    const { landThroughKernel } = await import('./kernel-client');
    const k = parker();
    const err = await landThroughKernel(input, { principal, deps: { ...local().deps, ...clock(), env: OWN, fetch: down, park: k.park as never } }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(err.parked).toBe(false);
    expect(k.parked).toEqual([]);
  });

  it('an answer is never parked: a refusal, the command\'s own failure, or a skew fallback', async () => {
    const { attemptEnded, KernelCommandFailedError } = await import('./kernel-client');
    const answers: Array<[() => Response, unknown]> = [
      [() => Response.json({ v: 1, code: 'forbidden', error: 'no reach' }, { status: 403 }), KernelCommandRefusedError],
      [() => Response.json({ v: 1, code: 'command_failed', error: 'boom' }, { status: 500 }), KernelCommandFailedError],
    ];
    for (const [reply, kind] of answers) {
      const k = parker();
      const err = await attemptEnded(end, { principal: runner, deps: { ...local().deps, env: OWN, fetch: (async () => reply()) as unknown as typeof fetch, park: k.park as never } }).catch((e) => e);
      expect(err).toBeInstanceOf(kind as never);
      expect(k.parked).toEqual([]);
    }
    const k = parker();
    const l = local();
    const older = (async () => Response.json({ v: 1, code: 'bad_request', error: 'unknown op "attempt_ended"' }, { status: 400 })) as unknown as typeof fetch;
    const realError = console.error;
    console.error = () => {};
    try {
      await attemptEnded(end, { principal: runner, deps: { ...l.deps, env: OWN, fetch: older, park: k.park as never } });
    } finally {
      console.error = realError;
    }
    expect(l.ran).toEqual(['attempt_ended']);
    expect(k.parked).toEqual([]);
  });

  it('a door with no principal is never parked (it is refused before sending), and a park that fails still answers unavailable', async () => {
    const { attemptEnded } = await import('./kernel-client');
    const k = parker();
    const refused = await attemptEnded(end, { principal: null, deps: { ...local().deps, ...clock(), env: OWN, fetch: down, park: k.park as never } }).catch((e) => e);
    expect(refused).toBeInstanceOf(KernelCommandRefusedError);
    expect(k.parked).toEqual([]);
    const realError = console.error;
    const logged: string[] = [];
    console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
    try {
      const err = await attemptEnded(end, { principal: runner, deps: { ...local().deps, ...clock(), env: OWN, fetch: down, park: async () => { throw new Error('db down'); } } }).catch((e) => e);
      expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
      expect(err.parked).toBe(false);
    } finally {
      console.error = realError;
    }
    expect(logged.join('\n')).toContain('could not be parked');
  });

  it('a reviewer\'s verdict that got no answer is parked; a fix claim never is (its claim is rolled back and claimed afresh)', async () => {
    const { recordReviewVerdict, claimFix } = await import('./kernel-client');
    const verdict = { workspaceId: WS, reviewerTask: { id: 'rv-1', deliveryId: DELIVERY, context: { workflowRoundId: 'r-1' } }, verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 0.9 };
    const k = parker();
    const err = await recordReviewVerdict(verdict, { principal: runner, idempotencyKey: 'record_review_verdict:k-park-3', deps: { ...local().deps, ...clock(), env: OWN, fetch: down, park: k.park as never } }).catch((e) => e);
    expect(err.parked).toBe(true);
    expect(k.parked).toMatchObject([{ key: 'record_review_verdict:k-park-3', op: 'record_review_verdict', input: verdict }]);

    const c = parker();
    const fixTask = { id: 'fix-1', workspaceId: WS, deliveryId: DELIVERY, deliveryRole: 'fix', context: { workflowAttemptId: 'a-1' } };
    const claimErr = await claimFix(fixTask, { principal: runner, deps: { ...local().deps, ...clock(), env: OWN, fetch: down, park: c.park as never } }).catch((e) => e);
    expect(claimErr).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(claimErr.parked).toBe(false);
    expect(c.parked).toEqual([]);
  });

  it('every op is classified, and the doors without another re-sender are the parked ones', async () => {
    const { PARK_ON_UNAVAILABLE } = await import('./command-outbox');
    const { KERNEL_OPS } = await import('./command-api');
    expect(Object.keys(PARK_ON_UNAVAILABLE).sort()).toEqual([...KERNEL_OPS].sort());
    expect(KERNEL_OPS.filter((op) => PARK_ON_UNAVAILABLE[op]).sort()).toEqual(['adopt_review_verdict', 'attempt_ended', 'attempt_requeued', 'observe_base', 'observe_ci_green', 'observe_head', 'record_review_verdict']);
    // A fix claim is rolled back and claimed afresh when unanswered: its old command is never re-sent.
    expect(PARK_ON_UNAVAILABLE.claim_fix).toBe(false);
    // AC-1 slice 7: nor a start: the claim projects it on its own host, and a late re-send could start a claim that moved on.
    expect(PARK_ON_UNAVAILABLE.attempt_started).toBe(false);
  });

  it('the door\'s 503 says it was parked', async () => {
    const { doorErrorAnswer } = await import('./kernel-client');
    const e = new ControlPlaneUnavailableError('unreachable', 'not_applied', 'attempt_ended:k-park-2');
    expect(doorErrorAnswer(e).body.parked).toBeUndefined();
    e.parked = true;
    expect(doorErrorAnswer(e).body).toMatchObject({ parked: true, idempotencyKey: 'attempt_ended:k-park-2', retryable: true });
  });
});

describe('T6 and T9 are doors too (AC-9): a review verdict (recorded or adopted) and a fix claim from the web host', () => {
  const OTHER = '44444444-4444-4444-8444-444444444444';
  const runner = { kind: 'account' as const, id: USER, grant: null };
  const verdict = { workspaceId: WS, reviewerTask: { id: 'rv-1', deliveryId: DELIVERY, context: { workflowRoundId: 'r-1' } }, verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 0.9 };
  const adopted = { workspaceId: WS, deliveryId: DELIVERY, reviewerTaskId: 'rv-2', verdict: 'request-changes', effectiveVerdict: 'request-changes', headSha: 'H1', confidence: 0.8 };
  const fixTask = { id: 'fix-1', workspaceId: WS, deliveryId: DELIVERY, deliveryRole: 'fix', context: { workflowAttemptId: 'a-1' } };
  type Door = 'recordReviewVerdict' | 'adoptReviewVerdict' | 'claimFix';
  const cases: Array<{ fn: Door; op: string; arg: unknown; sent: unknown }> = [
    { fn: 'recordReviewVerdict', op: 'record_review_verdict', arg: verdict, sent: verdict },
    { fn: 'adoptReviewVerdict', op: 'adopt_review_verdict', arg: adopted, sent: adopted },
    // The task's workspace rides on the input for the reach check, as attempt_ended's does.
    { fn: 'claimFix', op: 'claim_fix', arg: fixTask, sent: { task: fixTask, workspaceId: WS } },
  ];
  const call = async (fn: Door, arg: unknown, c: Record<string, unknown>) => {
    const client = await import('./kernel-client');
    return (client[fn] as (a: unknown, c: unknown) => Promise<unknown>)(arg, c);
  };

  for (const { fn, op, arg, sent } of cases) {
    it(`${op}: in own mode it is submitted to the control plane for its caller, and nothing runs here`, async () => {
      const l = local();
      const bodies: Array<Record<string, unknown>> = [];
      const fetchSpy = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({ op, result: { handled: false } }); }) as unknown as typeof fetch;
      expect(await call(fn, arg, { principal: runner, idempotencyKey: `${op}:k-0001`, deps: { ...l.deps, env: OWN, fetch: fetchSpy } })).toEqual({ handled: false });
      expect(l.ran).toEqual([]);
      expect(bodies).toEqual([{ v: 1, op, input: sent, principal: runner, idempotencyKey: `${op}:k-0001` }]);
    });

    it(`${op}: in shadow the web host runs it itself, as before`, async () => {
      const l = local();
      await call(fn, arg, { principal: runner, deps: { ...l.deps, env: {} } });
      expect(l.ran).toEqual([op]);
    });

    it(`${op}: release skew, a control plane that predates the op refused it as unknown, so the web host applies it itself and says so`, async () => {
      const l = local();
      const older = (async () => Response.json({ v: 1, code: 'bad_request', error: `unknown op "${op}"` }, { status: 400 })) as unknown as typeof fetch;
      const errors: unknown[] = [];
      const realError = console.error;
      console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
      try {
        await call(fn, arg, { principal: runner, deps: { ...l.deps, env: OWN, fetch: older } });
      } finally {
        console.error = realError;
      }
      expect(l.ran).toEqual([op]);
      expect(String(errors[0])).toContain('SKEW');
      expect(String(errors[0])).toContain(op);
    });

    it(`${op}: release skew only, any other refusal stays a refusal and nothing runs here`, async () => {
      for (const [status, code, error] of [[403, 'forbidden', 'account does not reach this workspace'], [400, 'bad_request', 'unknown op "land"']] as const) {
        const l = local();
        const refusing = (async () => Response.json({ v: 1, code, error }, { status })) as unknown as typeof fetch;
        const err = await call(fn, arg, { principal: runner, deps: { ...l.deps, env: OWN, fetch: refusing } }).catch((e) => e);
        expect(err).toBeInstanceOf(KernelCommandRefusedError);
        expect(l.ran).toEqual([]);
      }
    });

    it(`${op}: the command endpoint knows the op`, async () => {
      const { isKernelOp } = await import('./command-api');
      expect(isKernelOp(op)).toBe(true);
    });
  }

  it('claim_fix: the host claims a fix only for a task of the workspace the reach check judged', async () => {
    const { runKernelOp } = await import('./command-api');
    await expect(runKernelOp('claim_fix', { task: fixTask, workspaceId: OTHER })).rejects.toThrow(/not the task's workspace/);
  });

  it('a verdict names its workspace: without one the endpoint refuses it as malformed before any check', async () => {
    const { commandProblem } = await import('./command-api');
    const { workspaceId: _ws, ...noWorkspace } = verdict;
    expect(commandProblem({ v: 1, op: 'record_review_verdict', idempotencyKey: 'k-00000001', principal: runner, input: noWorkspace })).toBe('input.workspaceId must be a uuid');
  });
});

describe('a door after an unknown outcome', () => {
  it('submits again with the same key and returns the control plane\'s answer; a not_applied failure is not retried', async () => {
    const { landThroughKernel, DOOR_UNKNOWN_RETRIES } = await import('./kernel-client');
    const keys: string[] = [];
    let t = 0;
    // A budget of one attempt per submission, so each unknown outcome reaches the door.
    // (A door budget long enough for every retry: the budget has its own test below.)
    const base = { env: { ...OWN, KERNEL_COMMAND_BUDGET_MS: '1', KERNEL_DOOR_BUDGET_MS: '120000' }, now: () => t, sleep: async (ms: number) => { t += ms + 10_000; }, newKey: () => 'land:door-call-key', host: () => 'web' as const };
    // Two calls time out (outcome unknown), then the replay of the stored answer arrives.
    const replies: Array<() => Promise<Response>> = [
      async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
      async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
      async () => answer({ replayed: true }),
    ];
    const fetchImpl = (async (_u: string, init: RequestInit) => { keys.push(JSON.parse(String(init.body)).idempotencyKey); return replies.shift()!(); }) as unknown as typeof fetch;
    const r = await landThroughKernel(input, { principal, deps: { ...base, fetch: fetchImpl, run: (async () => { throw new Error('ran locally'); }) as never } });
    expect(r).toEqual({ merged: true, where: 'control-plane' } as never);
    expect(keys).toEqual(['land:door-call-key', 'land:door-call-key', 'land:door-call-key']);
    expect(DOOR_UNKNOWN_RETRIES).toBeGreaterThan(0);

    let refusedCalls = 0;
    const err = await landThroughKernel(input, {
      principal,
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
    const base = { env: { ...OWN, KERNEL_COMMAND_BUDGET_MS: '1', KERNEL_DOOR_BUDGET_MS: '120000' }, now: () => t, sleep: async (ms: number) => { t += ms + 10_000; }, newKey: () => 'land:door-k-0001', host: () => 'web' as const };
    for (const later of [
      async () => Response.json({ v: 1, code: 'not_host' }, { status: 409 }),
      async () => Response.json({ v: 1, code: 'unconfigured' }, { status: 503 }),
    ]) {
      const ran: string[] = [];
      const replies: Array<() => Promise<Response>> = [async () => { throw timeout(); }, later, later, later];
      const err = await landThroughKernel(input, {
      principal,
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

describe('a door\'s retry and time rules', () => {
  it('pins the rules: two more submissions after an unknown outcome, inside one 20 s budget', async () => {
    const { DOOR_UNKNOWN_RETRIES, DOOR_BUDGET_MS } = await import('./kernel-client');
    expect(DOOR_UNKNOWN_RETRIES).toBe(2);
    expect(DOOR_BUDGET_MS).toBe(20_000);
  });

  it('a refusal from the control plane (4xx) is never retried by the door', async () => {
    const { landThroughKernel, KernelCommandRefusedError } = await import('./kernel-client');
    let n = 0;
    const err = await landThroughKernel(input, { principal, deps: { env: OWN, host: () => 'web', sleep: async () => {}, fetch: (async () => { n++; return Response.json({ v: 1, code: 'forbidden', error: 'no' }, { status: 403 }); }) as unknown as typeof fetch } }).catch((e) => e);
    expect(err).toBeInstanceOf(KernelCommandRefusedError);
    expect(n).toBe(1);
  });

  it('the command failing on the control plane (command_failed) is the real error: reported, not retried', async () => {
    const { landThroughKernel, KernelCommandFailedError, doorErrorAnswer } = await import('./kernel-client');
    let n = 0;
    const err = await landThroughKernel(input, { principal, idempotencyKey: 'land:failed-0001', deps: { env: OWN, host: () => 'web', sleep: async () => {}, fetch: (async () => { n++; return Response.json({ v: 1, code: 'command_failed', error: 'delivery row missing', retryable: true }, { status: 500 }); }) as unknown as typeof fetch } }).catch((e) => e);
    expect(err).toBeInstanceOf(KernelCommandFailedError);
    expect(err.message).toContain('delivery row missing');
    expect(n).toBe(1);
    expect(doorErrorAnswer(err)).toMatchObject({ status: 500, body: { code: 'command_failed', retryable: false, idempotencyKey: 'land:failed-0001' } });
  });

  it('a local throw in shadow mode is the door\'s answer as it is: run once, never retried', async () => {
    const { landThroughKernel } = await import('./kernel-client');
    let runs = 0;
    const err = await landThroughKernel(input, { principal, deps: { env: { EXECUTION_MODE: 'shadow' }, host: () => 'web', run: (async () => { runs++; throw new Error('seam boom'); }) as never } }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('seam boom');
    expect(runs).toBe(1);
  });

  it('in shadow a door does not read the delivery afterwards (it never uses it)', async () => {
    const { landThroughKernel } = await import('./kernel-client');
    let reads = 0;
    await landThroughKernel(input, { principal, deps: { env: { EXECUTION_MODE: 'shadow' }, host: () => 'web', run: (async () => ({ merged: true })) as never, deliveryAfter: async () => { reads++; return null; } } });
    expect(reads).toBe(0);
  });

  it('one door call never outlasts its budget, whatever the control plane does', async () => {
    const { landThroughKernel, DOOR_BUDGET_MS } = await import('./kernel-client');
    let t = 0;
    let calls = 0;
    const err = await landThroughKernel(input, {
      principal,
      deps: {
        env: OWN, host: () => 'web', now: () => t, sleep: async (ms) => { t += ms; },
        // Every request hangs until its own timeout, then reads as unknown.
        fetch: (async () => { calls++; t += 8_000; throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch,
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(err.outcome).toBe('unknown');
    // The last request may start just before the deadline; nothing starts after it.
    expect(t).toBeLessThanOrEqual(DOOR_BUDGET_MS + 8_000 + 2_000);
    expect(calls).toBeLessThanOrEqual(4);
  });
});

/**
 * Incident 197552dc: after the kernel moved to the control plane, the hourly merge-state pass went
 * from seconds to the 60 s function limit. Its sweeps call doors and inline drains one after
 * another, each with a budget of its own (a door 20 s, a drain 10 s), so a control plane slow to
 * answer cost the sum of every budget. A pass now spends at most its own budget on the control
 * plane, however many calls it makes.
 */
describe('a pass\'s control-plane budget', () => {
  /** A control plane that never answers: each request runs until the client's own timeout fires. */
  function silentControlPlane(clock: { t: number }) {
    const realTimeout = AbortSignal.timeout;
    let lastTimeout = 0;
    AbortSignal.timeout = ((ms: number) => { lastTimeout = ms; return realTimeout.call(AbortSignal, ms); }) as typeof AbortSignal.timeout;
    const cp = {
      calls: 0,
      timeouts: [] as number[],
      fetch: (async () => { cp.calls++; cp.timeouts.push(lastTimeout); clock.t += lastTimeout; throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch,
      restore: () => { AbortSignal.timeout = realTimeout; },
    };
    return cp;
  }
  const deps = (clock: { t: number }, cp: { fetch: typeof fetch }): ClientDeps => ({
    env: OWN, host: () => 'web', now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, fetch: cp.fetch,
    run: (async () => { throw new Error('ran locally'); }) as never,
  });

  it('reproduction: N door calls one after another cost N door budgets without a pass budget', async () => {
    const { landThroughKernel, DOOR_BUDGET_MS } = await import('./kernel-client');
    const clock = { t: 0 };
    const cp = silentControlPlane(clock);
    try {
      for (let i = 0; i < 5; i++) await landThroughKernel(input, { principal, deps: deps(clock, cp) }).catch(() => null);
    } finally { cp.restore(); }
    // Five sweep candidates: well past a 60 s function limit.
    expect(clock.t).toBeGreaterThanOrEqual(5 * DOOR_BUDGET_MS);
  });

  it('inside a pass, N door calls stop at the pass budget; the rest are refused unsent, retryable, nothing applied', async () => {
    const { landThroughKernel, withControlPlaneBudget } = await import('./kernel-client');
    const clock = { t: 0 };
    const cp = silentControlPlane(clock);
    const errors: unknown[] = [];
    let report;
    try {
      ({ budget: report } = await withControlPlaneBudget('test-pass', 30_000, async () => {
        for (let i = 0; i < 5; i++) await landThroughKernel(input, { principal, deps: deps(clock, cp) }).catch((e) => errors.push(e));
      }, { now: () => clock.t }));
    } finally { cp.restore(); }
    // The pass budget, plus at most the back-off sleep after the last request.
    expect(clock.t).toBeLessThanOrEqual(30_000 + 2_000);
    expect(errors).toHaveLength(5);
    for (const e of errors) expect(e).toBeInstanceOf(ControlPlaneUnavailableError);
    const unsent = errors.filter((e) => (e as ControlPlaneUnavailableError).why.includes('spent its control-plane budget'));
    expect(unsent.length).toBeGreaterThanOrEqual(3);
    for (const e of unsent) expect((e as ControlPlaneUnavailableError).outcome).toBe('not_applied');
    expect(report!.refused).toBe(unsent.length);
    expect(report!.submitted).toBeGreaterThan(0);
  });

  it('inline drains in a pass wait briefly for their answer and are skipped once the budget is spent; outside a pass one waits its own budget', async () => {
    const { drainOnControlPlane, withControlPlaneBudget, INLINE_DRAIN_BUDGET_MS, PASS_DRAIN_WAIT_MS } = await import('./kernel-client');
    // Reproduction: twenty kernel-owned PRs in one sweep, each ending in an inline drain.
    const solo = { t: 0 };
    const cp1 = silentControlPlane(solo);
    try {
      for (let i = 0; i < 20; i++) expect(await drainOnControlPlane(DELIVERY, deps(solo, cp1))).toBeNull();
    } finally { cp1.restore(); }
    expect(solo.t).toBeGreaterThanOrEqual(20 * INLINE_DRAIN_BUDGET_MS);

    const clock = { t: 0 };
    const cp = silentControlPlane(clock);
    let report;
    try {
      ({ budget: report } = await withControlPlaneBudget('test-pass', 30_000, async () => {
        for (let i = 0; i < 20; i++) expect(await drainOnControlPlane(DELIVERY, deps(clock, cp))).toBeNull();
      }, { now: () => clock.t }));
    } finally { cp.restore(); }
    expect(clock.t).toBeLessThanOrEqual(30_000 + 2_000);
    // Each one waited at most 2.5 s (a literal: the pass's drain wait), never the request's 10 s.
    expect(Math.max(...cp.timeouts)).toBeLessThanOrEqual(2_500);
    expect(cp.calls).toBeGreaterThanOrEqual(10);
    expect(PASS_DRAIN_WAIT_MS).toBe(2_500);
    expect(report!.drainsSkipped).toBeGreaterThan(0);
    expect(report!.drainsSkipped + report!.submitted).toBe(20);
  });

  it('a submission inside a pass is cut to what is left of it, whatever budget its caller asked for', async () => {
    const { withControlPlaneBudget } = await import('./kernel-client');
    const clock = { t: 0 };
    const cp = silentControlPlane(clock);
    let errs: unknown[] = [];
    try {
      await withControlPlaneBudget('test-pass', 5_000, async () => {
        // The caller asks for 20 s; the pass has 5 s.
        errs.push(await submitKernelCommand('land', input, { principal, budgetMs: 20_000, deps: deps(clock, cp) }).catch((e) => e));
        expect(clock.t).toBeLessThanOrEqual(5_000 + 2_000);
        const before = cp.calls;
        errs.push(await submitKernelCommand('land', input, { principal, budgetMs: 20_000, deps: deps(clock, cp) }).catch((e) => e));
        // Spent: refused without a request.
        expect(cp.calls).toBe(before);
      }, { now: () => clock.t });
    } finally { cp.restore(); }
    expect((errs[1] as ControlPlaneUnavailableError).why).toContain('spent its control-plane budget');
    expect((errs[1] as ControlPlaneUnavailableError).outcome).toBe('not_applied');
  });

  it('nested passes keep the earlier deadline, and outside any pass nothing is budgeted', async () => {
    const { withControlPlaneBudget, controlPlaneBudgetLeft } = await import('./kernel-client');
    let t = 0;
    expect(controlPlaneBudgetLeft()).toBeNull();
    await withControlPlaneBudget('outer', 10_000, async () => {
      t = 4_000;
      await withControlPlaneBudget('inner', 30_000, async () => {
        expect(controlPlaneBudgetLeft()).toBe(6_000);
      }, { now: () => t });
    }, { now: () => t });
    expect(controlPlaneBudgetLeft()).toBeNull();
  });

  it('in shadow a pass sends nothing and its budget never binds: the command runs here', async () => {
    const { withControlPlaneBudget, landThroughKernel } = await import('./kernel-client');
    const l = local();
    const { value, budget } = await withControlPlaneBudget('test-pass', 0, () => landThroughKernel(input, { principal, deps: { ...l.deps, env: { ...OWN, EXECUTION_MODE: 'shadow' } } }));
    expect(value).toEqual({ merged: true, outcome: 'merged', where: 'here' } as never);
    expect(budget).toMatchObject({ submitted: 0, refused: 0 });
  });
});

/**
 * Incident 197552dc, the ledger's side: the cutover hours hold only a few `drain` rows, so the time
 * went on requests that never reached the claim. A request the control plane answers with a bare 5xx
 * before claiming (the Workers runtime's answer to an uncaught throw, or Cloudflare's own error page)
 * reads as "may have run": the client retries it for its whole budget, the door re-submits it, and no
 * ledger row is ever written.
 */
describe('time spent before the ledger claim', () => {
  const PASS_INPUT = { ...input, door: 'sweep', actor: 'system:test-sweep' };
  const system = { kind: 'system' as const, id: 'test-sweep' };

  /** The real endpoint whose ledger cannot be reached, behind the Workers runtime: an uncaught throw is a bare 500. */
  function controlPlane(clock: { t: number }) {
    const rows = new Set<string>();
    const ledger: CommandLedger = {
      claim: async () => { throw new Error('ledger unreachable'); },
      renew: async () => false, complete: async () => false, release: async () => {},
      read: async () => { throw new Error('ledger unreachable'); }, prune: async () => 0,
    };
    let requests = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests++;
      clock.t += 300;
      try {
        return await handleCommandRequest(new Request(url, init), { env: OWN, host: () => 'control-plane', ledger, reaches: async () => true, installationOf: async () => ({ installationId: 1 }), sleep: async () => {} });
      } catch {
        return new Response('error code: 1101', { status: 500 });
      }
    }) as unknown as typeof fetch;
    return { rows, fetchImpl, get requests() { return requests; } };
  }
  const depsOf = (clock: { t: number }, f: typeof fetch): ClientDeps => ({
    env: OWN, host: () => 'web', now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, fetch: f,
    run: (async () => { throw new Error('ran locally'); }) as never,
  });

  it('reproduction: a pre-claim bare 500 costs two door calls and a drain about 45 s, with no ledger row', async () => {
    const { landThroughKernel, drainOnControlPlane } = await import('./kernel-client');
    const clock = { t: 0 };
    let requests = 0;
    const bare500 = (async () => { requests++; clock.t += 300; return new Response('error code: 1101', { status: 500 }); }) as unknown as typeof fetch;
    const d = depsOf(clock, bare500);
    for (let i = 0; i < 2; i++) {
      const err = await landThroughKernel(PASS_INPUT, { principal: system, deps: d }).catch((e) => e);
      expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
      expect(err.outcome).toBe('unknown');
    }
    expect(await drainOnControlPlane(DELIVERY, d)).toBeNull();
    expect(clock.t).toBeGreaterThanOrEqual(45_000);
    expect(requests).toBeGreaterThan(20);
  });

  it('a ledger that does not answer before the claim is a 503 saying nothing ran: the door fails not_applied in about a second and is not re-submitted', async () => {
    const { landThroughKernel, drainOnControlPlane } = await import('./kernel-client');
    const clock = { t: 0 };
    const cp = controlPlane(clock);
    const d = depsOf(clock, cp.fetchImpl);
    for (let i = 0; i < 2; i++) {
      const err = await landThroughKernel(PASS_INPUT, { principal: system, deps: d }).catch((e) => e);
      expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
      expect([err.outcome, err.why]).toEqual(['not_applied', 'answered 503 ledger_unavailable']);
    }
    expect(await drainOnControlPlane(DELIVERY, d)).toBeNull();
    // Two requests per call (one retry), three calls; about a second each.
    expect(cp.requests).toBe(6);
    expect(clock.t).toBeLessThan(3_000);
  });
});

describe('a reach check the control plane could not make', () => {
  it('is answered 503 reach_unavailable; the client retries once and fails not_applied, and the door does not re-submit', async () => {
    const { landThroughKernel } = await import('./kernel-client');
    const clock = { t: 0 };
    let requests = 0;
    const ledger: CommandLedger = {
      claim: async () => { throw new Error('the reach check should come first'); },
      renew: async () => false, complete: async () => false, release: async () => {}, read: async () => null, prune: async () => 0,
    };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests++;
      clock.t += 300;
      return handleCommandRequest(new Request(url, init), { env: OWN, host: () => 'control-plane', ledger, reaches: async () => { throw new Error('db down'); }, installationOf: async () => ({ installationId: 1 }), sleep: async () => {} });
    }) as unknown as typeof fetch;
    const err = await landThroughKernel(input, {
      principal,
      deps: { env: OWN, host: () => 'web', now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, fetch: fetchImpl, run: (async () => { throw new Error('ran locally'); }) as never },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect([err.outcome, err.why]).toEqual(['not_applied', 'answered 503 reach_unavailable']);
    expect(requests).toBe(2);
    expect(clock.t).toBeLessThan(1_000);
  });
});

describe('an installation the control plane could not read', () => {
  it('is answered 503 installation_unavailable; the client retries once and fails not_applied, nothing ran', async () => {
    const { landThroughKernel } = await import('./kernel-client');
    const clock = { t: 0 };
    let requests = 0;
    const ledger: CommandLedger = {
      claim: async () => { throw new Error('the installation should be read first'); },
      renew: async () => false, complete: async () => false, release: async () => {}, read: async () => null, prune: async () => 0,
    };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests++;
      clock.t += 300;
      return handleCommandRequest(new Request(url, init), { env: OWN, host: () => 'control-plane', ledger, reaches: async () => true, installationOf: async () => { throw new Error('db down'); }, sleep: async () => {} });
    }) as unknown as typeof fetch;
    const err = await landThroughKernel(input, {
      principal,
      deps: { env: OWN, host: () => 'web', now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, fetch: fetchImpl, run: (async () => { throw new Error('ran locally'); }) as never },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    expect([err.outcome, err.why]).toEqual(['not_applied', 'answered 503 installation_unavailable']);
    expect(requests).toBe(2);
  });
});

describe('T12 from the conflict door is a door too (AC-9)', () => {
  const seen = { workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, installationId: 1, hint: 'dirty' as const, isDependencyBot: false, maxAgentAttempts: 3, source: 'door:conflict' };
  const sweep = { kind: 'system' as const, id: 'system:door-conflict' };

  it('in own mode it is submitted to the control plane, and nothing runs here', async () => {
    const { observeConflict } = await import('./kernel-client');
    const l = local();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({ op: 'observe_conflict', result: { handled: false } }); }) as unknown as typeof fetch;
    const r = await observeConflict(seen, { principal: sweep, idempotencyKey: 'observe_conflict:k-0001', deps: { ...l.deps, env: OWN, fetch: fetchSpy } });
    expect(r).toEqual({ handled: false });
    expect(l.ran).toEqual([]);
    expect(bodies).toEqual([{ v: 1, op: 'observe_conflict', input: seen, principal: sweep, idempotencyKey: 'observe_conflict:k-0001' }]);
  });

  it('in shadow the web host runs it itself, as before', async () => {
    const { observeConflict } = await import('./kernel-client');
    const l = local();
    await observeConflict(seen, { principal: sweep, deps: { ...l.deps, env: {} } });
    expect(l.ran).toEqual(['observe_conflict']);
  });

  it('release skew: a control plane that predates the op is refused as unknown, so the web host applies it itself and says so', async () => {
    const { observeConflict } = await import('./kernel-client');
    const l = local();
    const older = (async () => Response.json({ v: 1, code: 'bad_request', error: 'unknown op "observe_conflict"' }, { status: 400 })) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      await observeConflict(seen, { principal: sweep, deps: { ...l.deps, env: OWN, fetch: older } });
    } finally {
      console.error = realError;
    }
    expect(l.ran).toEqual(['observe_conflict']);
    expect(String(errors[0])).toContain('SKEW');
  });

  it('the command endpoint knows the op', async () => {
    const { isKernelOp } = await import('./command-api');
    expect(isKernelOp('observe_conflict')).toBe(true);
  });
});

describe('T17 to T19, T3 and T29 from the webhook and the sweeps are doors too (AC-9)', () => {
  const closed = { workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, installationId: 1, source: 'webhook:closed' };
  const pushed = { workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, installationId: 1, hintedHeadSha: 'H2', source: 'webhook:synchronize' };
  const retargeted = { workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, installationId: 1, hintedFromBase: 'dev', source: 'webhook:edited' };
  const webhook = { kind: 'system' as const, id: 'system:webhook:closed' };
  const down = (async () => { throw refusedErr(); }) as unknown as typeof fetch;
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms + 5_000; } }; };
  const replying = (result: unknown, bodies: Array<Record<string, unknown>> = []) =>
    (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return answer({ result }); }) as unknown as typeof fetch;
  /** GitHub's pull object, with more than the kernel reads. */
  const pull = {
    number: 7, state: 'closed', merged: true, merged_at: '2026-10-17T00:00:00Z', merge_commit_sha: 'M1', updated_at: '2026-10-17T00:00:01Z',
    mergeable_state: 'clean', draft: false, merged_by: { login: 'a-person', id: 9, avatar_url: 'x' }, body: 'a long body'.repeat(200),
    head: { sha: 'H1', ref: 'feat/x', repo: { full_name: 'acme/w', owner: { login: 'acme' } } }, base: { ref: 'dev', repo: { full_name: 'acme/w' } },
  };

  it('a close in own mode is submitted with GitHub\'s pull cut to what the kernel reads, and nothing runs here', async () => {
    const { observePrState } = await import('./kernel-client');
    const l = local();
    const bodies: Array<Record<string, unknown>> = [];
    const owned = await observePrState({ ...closed, pull }, { principal: webhook, idempotencyKey: 'observe_pr_state:k-0001', deps: { ...l.deps, env: OWN, fetch: replying({ owned: true }, bodies) } });
    expect(owned).toBe(true);
    expect(l.ran).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ op: 'observe_pr_state', principal: webhook, idempotencyKey: 'observe_pr_state:k-0001' });
    expect((bodies[0].input as Record<string, unknown>).pull).toEqual({
      state: 'closed', merged: true, merged_at: '2026-10-17T00:00:00Z', merge_commit_sha: 'M1', updated_at: '2026-10-17T00:00:01Z',
      mergeable_state: 'clean', draft: false, merged_by: { login: 'a-person' },
      head: { sha: 'H1', ref: 'feat/x', repo: { full_name: 'acme/w' } }, base: { ref: 'dev' },
    });
    const { toLivePr } = await import('./github-facts');
    expect(toLivePr((bodies[0].input as { pull: never }).pull)).toEqual(toLivePr(pull as never));
  });

  it('the control plane\'s failed live read comes back as KernelObservationFailed, as the seam threw it', async () => {
    const { observePrState, KernelObservationFailed } = await import('./kernel-client');
    const err = await observePrState(closed, { principal: webhook, deps: { ...local().deps, env: OWN, fetch: replying({ owned: true, observationFailed: { deliveryId: DELIVERY, reason: 'github 502' } }) } }).catch((e) => e);
    expect(err).toBeInstanceOf(KernelObservationFailed);
    expect(err).toMatchObject({ name: 'KernelObservationFailed', deliveryId: DELIVERY, reason: 'github 502' });
  });

  it('not the kernel\'s PR: false, so legacy decides', async () => {
    const { observePrState } = await import('./kernel-client');
    expect(await observePrState(closed, { principal: webhook, deps: { ...local().deps, env: OWN, fetch: replying({ owned: false }) } })).toBe(false);
  });

  it('the control plane down on a kernel-owned close: recorded unapplied here and healed, KernelObservationFailed, never parked', async () => {
    const { observePrState, KernelObservationFailed } = await import('./kernel-client');
    const l = local();
    const recorded: Array<[string, Record<string, unknown>]> = [];
    const parked: unknown[] = [];
    const err = await observePrState({ ...closed, pull }, {
      principal: webhook,
      deps: {
        ...l.deps, ...clock(), env: OWN, fetch: down, park: (async (p: unknown) => { parked.push(p); return true; }) as never,
        kernelDeliveryOf: async () => DELIVERY,
        recordUnapplied: async (id, p) => { recorded.push([id, p as Record<string, unknown>]); },
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(KernelObservationFailed);
    expect(err.deliveryId).toBe(DELIVERY);
    expect(recorded).toHaveLength(1);
    expect(recorded[0][0]).toBe(DELIVERY);
    expect(recorded[0][1]).toMatchObject({ ...closed, pull: { state: 'closed', merged: true } });
    expect(parked).toEqual([]);
    expect(l.ran).toEqual([]);
  });

  it('the control plane down on a PR the kernel does not own: false, nothing recorded', async () => {
    const { observePrState } = await import('./kernel-client');
    const recorded: unknown[] = [];
    const owned = await observePrState(closed, {
      principal: webhook,
      deps: { ...local().deps, ...clock(), env: OWN, fetch: down, kernelDeliveryOf: async () => null, recordUnapplied: async (...a) => { recorded.push(a); } },
    });
    expect(owned).toBe(false);
    expect(recorded).toEqual([]);
  });

  /** Answers that are not an outage: a refused installation (4xx) and the command's own failure (500). */
  const refusing = (async () => Response.json({ v: 1, code: 'installation_unresolved', error: 'no installation' }, { status: 422 })) as unknown as typeof fetch;
  const failing = (async () => Response.json({ v: 1, code: 'command_failed', error: 'boom' }, { status: 500 })) as unknown as typeof fetch;

  it('regression: a refused or failed door on a kernel-owned close is never read as "not the kernel\'s PR": recorded unapplied and healed, KernelObservationFailed', async () => {
    const { observePrState, KernelObservationFailed } = await import('./kernel-client');
    const realError = console.error;
    console.error = () => {};
    try {
      for (const fetch of [refusing, failing]) {
        const recorded: Array<[string, unknown]> = [];
        const err = await observePrState({ ...closed, pull }, { principal: webhook, deps: { ...local().deps, env: OWN, fetch, kernelDeliveryOf: async () => DELIVERY, recordUnapplied: async (id, p) => { recorded.push([id, p]); } } }).catch((e) => e);
        expect(err).toBeInstanceOf(KernelObservationFailed);
        expect(err.deliveryId).toBe(DELIVERY);
        expect(recorded.map(([id]) => id)).toEqual([DELIVERY]);
      }
    } finally {
      console.error = realError;
    }
  });

  it('a refused or failed door on a PR the kernel does not own: false, so legacy decides, nothing recorded', async () => {
    const { observePrState } = await import('./kernel-client');
    for (const fetch of [refusing, failing]) {
      const recorded: unknown[] = [];
      expect(await observePrState(closed, { principal: webhook, deps: { ...local().deps, env: OWN, fetch, kernelDeliveryOf: async () => null, recordUnapplied: async (...a) => { recorded.push(a); } } })).toBe(false);
      expect(recorded).toEqual([]);
    }
  });

  it('regression: a refused or failed push or retarget reads ownership here, so legacy never re-reviews a kernel PR', async () => {
    const { observeHead, observeBase } = await import('./kernel-client');
    const realError = console.error;
    console.error = () => {};
    try {
      for (const [fn, p] of [[observeHead, pushed], [observeBase, retargeted]] as const) {
        for (const fetch of [refusing, failing]) {
          const call = fn as (p: unknown, c: unknown) => Promise<boolean>;
          expect(await call(p, { principal: webhook, deps: { ...local().deps, env: OWN, fetch, kernelDeliveryOf: async () => DELIVERY } })).toBe(true);
          expect(await call(p, { principal: webhook, deps: { ...local().deps, env: OWN, fetch, kernelDeliveryOf: async () => null } })).toBe(false);
        }
      }
    } finally {
      console.error = realError;
    }
  });

  it('in shadow the web host runs all three itself, as before', async () => {
    const { observePrState, observeHead, observeBase } = await import('./kernel-client');
    const l = local();
    const run = (async (op: string) => { l.ran.push(op); return op === 'observe_pr_state' ? { owned: true } : true; }) as ClientDeps['run'];
    expect(await observePrState(closed, { principal: webhook, deps: { ...l.deps, run, env: {} } })).toBe(true);
    expect(await observeHead(pushed, { principal: webhook, deps: { ...l.deps, run, env: {} } })).toBe(true);
    expect(await observeBase(retargeted, { principal: webhook, deps: { ...l.deps, run, env: {} } })).toBe(true);
    expect(l.ran).toEqual(['observe_pr_state', 'observe_head', 'observe_base']);
  });

  it('a push and a retarget in own mode are submitted, and nothing runs here', async () => {
    const { observeHead, observeBase } = await import('./kernel-client');
    const l = local();
    const bodies: Array<Record<string, unknown>> = [];
    expect(await observeHead(pushed, { principal: webhook, deps: { ...l.deps, env: OWN, fetch: replying(true, bodies) } })).toBe(true);
    expect(await observeBase(retargeted, { principal: webhook, deps: { ...l.deps, env: OWN, fetch: replying(false, bodies) } })).toBe(false);
    expect(bodies.map((b) => [b.op, b.input])).toEqual([['observe_head', pushed], ['observe_base', retargeted]]);
    expect(l.ran).toEqual([]);
  });

  it('GitHub sends a push and a retarget once: with the control plane down they are parked under their key, and ownership is read here', async () => {
    const { observeHead, observeBase } = await import('./kernel-client');
    for (const [fn, p, op] of [[observeHead, pushed, 'observe_head'], [observeBase, retargeted, 'observe_base']] as const) {
      const parked: Array<Record<string, unknown>> = [];
      const l = local();
      const deps = { ...l.deps, ...clock(), env: OWN, fetch: down, park: (async (x: Record<string, unknown>) => { parked.push(x); return true; }) as never };
      expect(await (fn as (p: unknown, c: unknown) => Promise<boolean>)(p, { principal: webhook, idempotencyKey: `${op}:k-park-1`, deps: { ...deps, kernelDeliveryOf: async () => DELIVERY } })).toBe(true);
      expect(parked).toEqual([expect.objectContaining({ key: `${op}:k-park-1`, op, input: p, principal: webhook })]);
      // A PR the kernel does not own: legacy acts (false).
      expect(await (fn as (p: unknown, c: unknown) => Promise<boolean>)(p, { principal: webhook, deps: { ...deps, kernelDeliveryOf: async () => null } })).toBe(false);
      expect(l.ran).toEqual([]);
    }
  });

  it('release skew: an older control plane refuses each as unknown, so the web host applies it itself', async () => {
    const { observePrState, observeHead, observeBase } = await import('./kernel-client');
    const realError = console.error;
    console.error = () => {};
    try {
      for (const [fn, p, op] of [[observePrState, closed, 'observe_pr_state'], [observeHead, pushed, 'observe_head'], [observeBase, retargeted, 'observe_base']] as const) {
        const l = local();
        const run = (async (o: string) => { l.ran.push(o); return o === 'observe_pr_state' ? { owned: true } : true; }) as ClientDeps['run'];
        const older = (async () => Response.json({ v: 1, code: 'bad_request', error: `unknown op "${op}"` }, { status: 400 })) as unknown as typeof fetch;
        expect(await (fn as (p: unknown, c: unknown) => Promise<boolean>)(p, { principal: webhook, deps: { ...l.deps, run, env: OWN, fetch: older } })).toBe(true);
        expect(l.ran).toEqual([op]);
      }
    } finally {
      console.error = realError;
    }
  });

  it('the endpoint knows the ops; a close is not parked (it is recorded and healed), a push and a retarget are', async () => {
    const { isKernelOp, INSTALLATION_OPS } = await import('./command-api');
    const { shouldPark } = await import('./command-outbox');
    for (const op of ['observe_pr_state', 'observe_head', 'observe_base'] as const) {
      expect(isKernelOp(op)).toBe(true);
      expect(INSTALLATION_OPS.has(op)).toBe(true);
    }
    expect([shouldPark('observe_pr_state'), shouldPark('observe_head'), shouldPark('observe_base')]).toEqual([false, true, true]);
  });
});

describe('a webhook request answers inside GitHub\'s timeout when the control plane hangs', () => {
  const webhook = { kind: 'system' as const, id: 'system:webhook:check_suite' };
  const hanging = ((_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal?.addEventListener('abort', () => rej(init.signal!.reason)); })) as unknown as typeof fetch;
  const greenFor = (prNumber: number) => ({ workspaceId: WS, repoFullName: 'acme/w', prNumber, installationId: 1, headSha: 'H1', source: 'webhook:check_suite' });
  const parker = () => {
    const parked: Array<Record<string, unknown>> = [];
    return { parked, park: (async (p: Record<string, unknown>) => { parked.push(p); return true; }) as never };
  };

  afterEach(async () => { (await import('./kernel-client')).resetWebhookBreaker(); });

  it('the budgets sit well under the ten seconds GitHub allows', async () => {
    const { WEBHOOK_BUDGET_MS, WEBHOOK_DOOR_BUDGET_MS } = await import('./kernel-client');
    expect(WEBHOOK_DOOR_BUDGET_MS).toBeLessThanOrEqual(WEBHOOK_BUDGET_MS);
    expect(WEBHOOK_BUDGET_MS).toBeLessThanOrEqual(7_000);
  });

  it('three doors against a hanging control plane: back within the bound, the first waits its budget, the rest skip it, and every green is parked under a key from the delivery', async () => {
    const { observeCiGreen, withWebhookBudget } = await import('./kernel-client');
    const k = parker();
    let sent = 0;
    const counting = ((u: string, init: RequestInit) => { sent++; return (hanging as unknown as (u: string, i: RequestInit) => Promise<Response>)(u, init); }) as unknown as typeof fetch;
    const deps = { ...local().deps, sleep: undefined, env: OWN, fetch: counting, park: k.park };
    const t0 = Date.now();
    const errs = await withWebhookBudget('delivery-abc', async () => {
      const out: unknown[] = [];
      for (const n of [1, 2, 3]) out.push(await observeCiGreen(greenFor(n), { principal: webhook, deps }).catch((e) => e));
      return out;
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
    for (const e of errs) expect(e).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(sent).toBe(1);
    expect(k.parked).toHaveLength(3);
    for (const p of k.parked) expect(p).toMatchObject({ op: 'observe_ci_green', principal: webhook });
    expect(new Set(k.parked.map((p) => p.key)).size).toBe(3);
    for (const p of k.parked) expect(String(p.key)).toMatch(/^webhook:delivery-abc:observe_ci_green:[0-9a-f]{16}$/);
  }, 15_000);

  it('a push and a retarget are parked the same way (and ownership is still read here)', async () => {
    const { observeHead, observeBase, withWebhookBudget } = await import('./kernel-client');
    const k = parker();
    const deps = { ...local().deps, sleep: undefined, env: { ...OWN, KERNEL_WEBHOOK_DOOR_BUDGET_MS: '200' }, fetch: hanging, park: k.park, kernelDeliveryOf: async () => DELIVERY };
    const t0 = Date.now();
    const [head, base] = await withWebhookBudget('delivery-def', async () => [
      await observeHead({ workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, installationId: 1, hintedHeadSha: 'H2', source: 'webhook:synchronize' }, { principal: webhook, deps }),
      await observeBase({ workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, installationId: 1, hintedFromBase: 'dev', source: 'webhook:edited' }, { principal: webhook, deps }),
    ], { env: deps.env });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect([head, base]).toEqual([true, true]);
    expect(k.parked.map((p) => p.op)).toEqual(['observe_head', 'observe_base']);
  });

  it('a close is recorded unapplied for the fast heal, and the caller is told the read failed', async () => {
    const { observePrState, withWebhookBudget, KernelObservationFailed } = await import('./kernel-client');
    const recorded: Array<[string, unknown]> = [];
    const deps = {
      ...local().deps, sleep: undefined, env: { ...OWN, KERNEL_WEBHOOK_DOOR_BUDGET_MS: '200' }, fetch: hanging,
      kernelDeliveryOf: async () => DELIVERY, recordUnapplied: async (d: string, p: unknown) => { recorded.push([d, p]); },
    };
    const t0 = Date.now();
    const err = await withWebhookBudget('delivery-ghi', () => observePrState(
      { workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, installationId: 1, source: 'webhook:closed', pull: { number: 7, state: 'closed', merged: true } },
      { principal: { kind: 'system', id: 'system:webhook:closed' }, deps },
    ), { env: deps.env }).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(err).toBeInstanceOf(KernelObservationFailed);
    expect(recorded).toHaveLength(1);
    expect(recorded[0][0]).toBe(DELIVERY);
  });

  it('a door with no durable fallback (open_delivery, land) is not capped, never trips the breaker and is not refused by a spent request budget', async () => {
    const { openKernelDelivery, landThroughKernel, observeCiGreen, withWebhookBudget, WEBHOOK_CAPPED_OPS } = await import('./kernel-client');
    expect([...WEBHOOK_CAPPED_OPS].sort()).toEqual(['observe_base', 'observe_ci_failure', 'observe_ci_green', 'observe_conflict', 'observe_head', 'observe_pr_state']);
    const sent: string[] = [];
    // Answers after 400 ms: far past the 100 ms cap below, so a capped door would give up and legacy would take the PR.
    const slow = ((_u: string, init: RequestInit) => {
      const op = JSON.parse(String(init.body)).op as string;
      sent.push(op);
      return new Promise((res) => setTimeout(() => res(answer({ op, result: op === 'open_delivery' ? { owned: true } : { merged: true } })), 400));
    }) as unknown as typeof fetch;
    const env = { ...OWN, KERNEL_WEBHOOK_DOOR_BUDGET_MS: '100', KERNEL_WEBHOOK_BUDGET_MS: '100' };
    const deps = { ...local().deps, sleep: undefined, env, fetch: slow, park: parker().park };
    const opened = { workspaceId: WS, ownerTaskId: 't-1', repoFullName: 'acme/w', prNumber: 7, installationId: 1, source: 'webhook:opened' };
    const out = await withWebhookBudget('delivery-open', async () => {
      const first = await openKernelDelivery(opened as never, { principal: webhook, deps });
      const landed = await landThroughKernel(input as never, { principal: webhook, deps });
      // The request's own budget is spent by now; the uncapped doors still ran, and the breaker is closed.
      const green = await observeCiGreen(greenFor(7), { principal: webhook, deps }).catch((e) => e);
      return { first, landed, green };
    }, { env });
    expect(out.first).toEqual({ owned: true });
    expect(out.landed).toEqual({ merged: true });
    expect(sent.slice(0, 2)).toEqual(['open_delivery', 'land']);
    // The capped door is the one that gave up (and is parked); the uncapped ones did not open the breaker beforehand.
    expect(out.green).toBeInstanceOf(ControlPlaneUnavailableError);
  });

  it('outside a webhook the door keeps its own budget (no cap, no breaker)', async () => {
    const { observeCiGreen, withWebhookBudget } = await import('./kernel-client');
    const down = (async () => { throw refusedErr(); }) as unknown as typeof fetch;
    // A webhook door that fails opens the breaker...
    let t = 0;
    const now = () => t;
    await withWebhookBudget('delivery-x', () => observeCiGreen(greenFor(1), { principal: webhook, deps: { ...local().deps, env: OWN, fetch: down, now, sleep: async (ms: number) => { t += ms + 5_000; }, park: parker().park } }).catch(() => null), { now });
    // ...but a sweep's door call is not skipped by it.
    let sent = 0;
    const ok = (async () => { sent++; return answer({ op: 'observe_ci_green', result: { handled: false } }); }) as unknown as typeof fetch;
    expect(await observeCiGreen(greenFor(2), { principal: webhook, deps: { ...local().deps, env: OWN, fetch: ok, now } })).toEqual({ handled: false });
    expect(sent).toBe(1);
  });

  it('a redelivery after a slow apply that succeeded is a no-op: same key, one apply, and the floor\'s replay of the parked row is the same command', async () => {
    const { observeCiGreen, withWebhookBudget } = await import('./kernel-client');
    const { drainParkedCommands, resubmitFromWeb } = await import('./command-outbox');
    // A control plane with a ledger: it applies a command once per key and answers a repeat with what was done.
    const ledger = new Map<string, unknown>();
    let applied = 0;
    let slow = true;
    const controlPlane = ((_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { idempotencyKey: string };
      const seen = ledger.has(body.idempotencyKey);
      if (!seen) { applied++; ledger.set(body.idempotencyKey, { handled: true }); }
      if (slow && !seen) return new Promise((_r, rej) => { init.signal?.addEventListener('abort', () => rej(init.signal!.reason)); });
      return Promise.resolve(answer({ op: 'observe_ci_green', idempotencyKey: body.idempotencyKey, result: ledger.get(body.idempotencyKey), replayed: seen }));
    }) as unknown as typeof fetch;
    const k = parker();
    const deps = { ...local().deps, sleep: undefined, env: { ...OWN, KERNEL_WEBHOOK_DOOR_BUDGET_MS: '150' }, fetch: controlPlane, park: k.park };
    const deliver = () => withWebhookBudget('delivery-redo', () => observeCiGreen(greenFor(7), { principal: webhook, deps }).catch((e) => e), { env: deps.env });

    // First delivery: applied, but the answer came too late. It is parked under the delivery's key.
    expect(await deliver()).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(applied).toBe(1);
    expect(k.parked).toHaveLength(1);
    const key = String(k.parked[0].key);
    const { resetWebhookBreaker } = await import('./kernel-client');
    resetWebhookBreaker();

    // GitHub's redelivery: the same key, answered from the ledger.
    slow = false;
    expect(await deliver()).toEqual({ handled: true });
    expect(applied).toBe(1);
    expect(k.parked).toHaveLength(1);

    // The floor's replay of the parked row: still the same command.
    const row = { key, op: 'observe_ci_green', input: k.parked[0].input as Record<string, unknown>, principal: webhook, priorUnknown: true, attempt: 1 };
    const log: string[] = [];
    await drainParkedCommands({
      outbox: {
        park: async () => true, claimDue: async () => [row],
        settle: async (_r, outcome) => { log.push(outcome); return true; }, retry: async () => true, bury: async () => true, prune: async () => 0,
      },
      ledger: { read: async () => null } as never,
      host: () => 'web',
      resubmit: (r) => resubmitFromWeb(r, { priorUnknown: r.priorUnknown, deps: { ...deps, env: OWN } }),
    });
    expect(applied).toBe(1);
    expect(log).toEqual(['replayed:answered']);
  }, 15_000);
});
