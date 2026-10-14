/**
 * The kernel command endpoint (docs/specs/workflow-kernel-library.md §3,
 * AC-11): who may submit, which host applies, and that one idempotency key is
 * one execution with one answer. The ledger here is an in-memory model of
 * command-ledger.ts's statements; the Postgres ledger runs the same contract
 * under `bun run test:db` (tests/db/kernel-command-host.test.ts).
 */
import { describe, expect, it } from 'bun:test';
import { signRequest } from '@buildd/dispatch-contract';
import { COMMAND_PATH, commandKeyRing, commandProblem, handleCommandRequest, principalKey, principalReaches, requestHash, sessionOfPrincipal, type CommandServerDeps, type KernelPrincipal, type ReachDeps } from './command-api';
import { assertGrantedWorkspace } from '../grant-scope';
import type { CommandLedger, LedgerRow, StoredAnswer } from './command-ledger';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const DELIVERY = '33333333-3333-4333-8333-333333333333';
const ENV = { EXECUTION_MODE: 'own', KERNEL_COMMAND_SECRET: 'k1:test-secret' };

/** command-ledger.ts's semantics in memory: claim is insert-or-takeover, complete/release only for the current token. */
function memoryLedger(): CommandLedger & { rows: Map<string, LedgerRow & { token: string }> } {
  const rows = new Map<string, LedgerRow & { token: string }>();
  return {
    rows,
    async claim(p) {
      if (rows.has(p.key)) return false;
      rows.set(p.key, { key: p.key, op: p.op, principal: p.principal, requestHash: p.requestHash, status: 'running', response: null, claimedAt: new Date().toISOString(), token: p.token });
      return true;
    },
    async complete(p) {
      const r = rows.get(p.key);
      if (!r || r.status !== 'running' || r.token !== p.token) return false;
      r.status = 'done';
      r.response = p.response as StoredAnswer;
      return true;
    },
    async release(p) {
      const r = rows.get(p.key);
      if (r && r.status === 'running' && r.token === p.token) rows.delete(p.key);
    },
    async read(key) { return rows.get(key) ?? null; },
    async prune() { return 0; },
  };
}

const landInput = { workspaceId: WS, installationId: 1, repoFullName: 'acme/w', prNumber: 7, headSha: 'H1', door: 'dashboard', actor: `human:${USER}` };

function body(o: Record<string, unknown> = {}) {
  return { v: 1, op: 'land', input: landInput, principal: { kind: 'user', id: USER }, idempotencyKey: 'land:key-0001', ...o };
}

async function signed(b: unknown, secret = 'test-secret', keyId = 'k1'): Promise<Request> {
  const text = JSON.stringify(b);
  const headers = await signRequest({ keyId, secret, method: 'POST', path: COMMAND_PATH, body: text });
  return new Request(`https://control-plane.buildd.dev${COMMAND_PATH}`, { method: 'POST', body: text, headers });
}

function server(o: Partial<CommandServerDeps> = {}) {
  const ran: unknown[] = [];
  const ledger = memoryLedger();
  const deps: CommandServerDeps = {
    env: ENV,
    host: () => 'control-plane',
    ledger,
    reaches: async () => true,
    run: (async (op: string, input: unknown) => { ran.push({ op, input }); return { merged: true, outcome: 'merged' }; }) as CommandServerDeps['run'],
    deliveryAfter: async () => ({ id: DELIVERY, version: 9 }),
    sleep: async () => {},
    ...o,
  };
  return { ran, ledger, call: (req: Request) => handleCommandRequest(req, deps) };
}

describe('only the control plane in own mode applies a command', () => {
  it('the web host, and the control plane in shadow, answer not_host and run nothing', async () => {
    for (const o of [{ host: () => 'web' as const }, { env: { ...ENV, EXECUTION_MODE: 'shadow' } }, { env: { KERNEL_COMMAND_SECRET: 'k1:test-secret' } }]) {
      const s = server(o);
      const res = await s.call(await signed(body()));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('not_host');
      expect(s.ran).toEqual([]);
    }
  });
});

describe('authentication', () => {
  it('no key configured: 503, nothing run', async () => {
    const s = server({ env: { EXECUTION_MODE: 'own' } });
    const res = await s.call(await signed(body()));
    expect([res.status, (await res.json()).code]).toEqual([503, 'unconfigured']);
    expect(s.ran).toEqual([]);
  });

  it('unsigned, wrongly signed, or signed over another body: 401, nothing run', async () => {
    const s = server();
    const unsigned = new Request(`https://control-plane.buildd.dev${COMMAND_PATH}`, { method: 'POST', body: JSON.stringify(body()) });
    const wrong = await signed(body(), 'not-the-secret');
    const swapped = await signed(body());
    const tampered = new Request(swapped.url, { method: 'POST', headers: swapped.headers, body: JSON.stringify(body({ input: { ...landInput, headSha: 'H9' } })) });
    for (const req of [unsigned, wrong, tampered]) expect((await s.call(req)).status).toBe(401);
    expect(s.ran).toEqual([]);
  });

  it('the principal must still reach the workspace: 403 otherwise; drain is system-only', async () => {
    const s = server({ reaches: async () => false });
    const res = await s.call(await signed(body()));
    expect([res.status, (await res.json()).code]).toEqual([403, 'forbidden']);
    const d = server();
    const drain = await d.call(await signed(body({ op: 'drain', input: { deliveryId: DELIVERY } })));
    expect(drain.status).toBe(403);
    expect([...s.ran, ...d.ran]).toEqual([]);
  });

  it('the key ring is the dedicated KERNEL_COMMAND_SECRET only: nothing is derived from another secret', () => {
    expect(commandKeyRing({ KERNEL_COMMAND_SECRET: 'a:1,b:2', CRON_SECRET: 'c' })).toEqual({ a: '1', b: '2' });
    expect(commandKeyRing({ CRON_SECRET: 'cron-secret' })).toEqual({});
    expect(commandKeyRing({})).toEqual({});
  });

  it('with KERNEL_COMMAND_SECRET unset the control plane refuses every command, however it is signed', async () => {
    const s = server({ env: { EXECUTION_MODE: 'own', CRON_SECRET: 'test-secret' } });
    for (const req of [await signed(body()), await signed(body(), 'test-secret', 'cron'), new Request(`https://control-plane.buildd.dev${COMMAND_PATH}`, { method: 'POST', body: '{}' })]) {
      const res = await s.call(req);
      expect([res.status, (await res.json()).code]).toEqual([503, 'unconfigured']);
    }
    expect(s.ran).toEqual([]);
  });
});

describe('the v1 request shape', () => {
  it('names a version, a known op, a key, a principal and a workspace', () => {
    expect(commandProblem(body())).toBeNull();
    expect(commandProblem(body({ v: 2 }))).toContain('unsupported version');
    expect(commandProblem(body({ op: 'mergeEverything' }))).toContain('unknown op');
    expect(commandProblem(body({ idempotencyKey: 'x' }))).toContain('idempotencyKey');
    expect(commandProblem(body({ principal: { kind: 'user', id: 'not-a-uuid' } }))).toContain('principal');
    expect(commandProblem(body({ input: { ...landInput, workspaceId: 'w' } }))).toContain('workspaceId');
    expect(commandProblem(body({ input: { ...landInput, prNumber: -1 } }))).toContain('prNumber');
    expect(commandProblem(body({ op: 'drain', input: { deliveryId: DELIVERY }, principal: { kind: 'system', id: 'inline-drain' } }))).toBeNull();
  });

  it('a malformed request is 400 and runs nothing', async () => {
    const s = server();
    const res = await s.call(await signed(body({ op: 'nope' })));
    expect(res.status).toBe(400);
    expect(s.ran).toEqual([]);
  });
});

const ACCT = '44444444-4444-4444-8444-444444444444';
const OTHER_WS = '55555555-5555-4555-8555-555555555555';
const grantP = (o: Record<string, unknown> = {}) => ({ kind: 'grant', id: ACCT, grantId: 'grant-1', workspaceIds: [WS], scopes: ['read', 'write'], ...o });

describe('the principal carries the grant a session is confined to', () => {
  it('a grant principal is well formed only with its grant, a uuid workspace list and its scopes', () => {
    expect(commandProblem(body({ principal: grantP() }))).toBeNull();
    expect(commandProblem(body({ principal: grantP({ userId: USER }) }))).toBeNull();
    expect(commandProblem(body({ principal: grantP({ workspaceIds: [] }) }))).toBeNull();
    for (const bad of [grantP({ grantId: '' }), grantP({ grantId: undefined }), grantP({ workspaceIds: undefined }), grantP({ workspaceIds: ['ws'] }),
      grantP({ scopes: 'write' }), grantP({ id: 'not-a-uuid' }), grantP({ userId: 'nope' })]) {
      expect(commandProblem(body({ principal: bad }))).toContain('principal');
    }
    // A plain account says it is not a grant, and cannot smuggle one in under `account`.
    expect(commandProblem(body({ principal: { kind: 'account', id: ACCT, grant: null } }))).toBeNull();
    expect(commandProblem(body({ principal: { kind: 'account', id: ACCT, grant: { id: 'g' } } }))).toContain('principal');
  });

  it('the ledger records a grant session by its grant', () => {
    expect(principalKey(grantP() as KernelPrincipal)).toBe('grant:grant-1');
    expect(principalKey({ kind: 'account', id: ACCT, grant: null })).toBe(`account:${ACCT}`);
  });

  it('the control plane rebuilds the session the web host judged', () => {
    expect(sessionOfPrincipal(grantP() as Extract<KernelPrincipal, { kind: 'grant' }>)).toEqual({ id: ACCT, oauthGrantId: 'grant-1', grantScopes: ['read', 'write'], workspaceIds: [WS] });
    expect(sessionOfPrincipal({ kind: 'account', id: ACCT, grant: null })).toEqual({ id: ACCT, oauthGrantId: null });
  });
});

/** principalReaches with the team-access checks recorded: the grant arm is team-access's own first branch. */
function reach(o: { sessionAccount?: boolean; accountReaches?: boolean } = {}) {
  const calls: unknown[] = [];
  const deps: ReachDeps = {
    verifyWorkspaceAccess: async (u, w) => { calls.push(['user', u, w]); return { teamId: 't', role: 'member' }; },
    verifyAccountWorkspaceAccess: async (acct, w) => {
      calls.push(['account', acct, w]);
      if (acct.oauthGrantId) return assertGrantedWorkspace(acct, w, 'read');
      return o.accountReaches ?? true;
    },
    isSessionAccount: async (id) => { calls.push(['session?', id]); return o.sessionAccount ?? false; },
  };
  return { calls, check: (p: KernelPrincipal, w: string | null) => principalReaches(p, w, deps) };
}

describe('principalReaches applies the web host\'s rule', () => {
  it('a grant session reaches exactly its granted workspaces, judged on the grant and never the shared account', async () => {
    const r = reach({ accountReaches: true });
    expect(await r.check(grantP() as KernelPrincipal, WS)).toBe(true);
    expect(await r.check(grantP() as KernelPrincipal, OTHER_WS)).toBe(false);
    expect(await r.check(grantP({ workspaceIds: [] }) as KernelPrincipal, WS)).toBe(false);
    expect(r.calls.every((c) => (c as unknown[])[0] === 'account' && ((c as unknown[])[1] as { oauthGrantId: unknown }).oauthGrantId === 'grant-1')).toBe(true);
  });

  it('a plain account is judged on its own row, whether or not it is a team\'s session account', async () => {
    const r = reach({ sessionAccount: true, accountReaches: true });
    expect(await r.check({ kind: 'account', id: ACCT, grant: null }, WS)).toBe(true);
    expect(r.calls).toEqual([['account', { id: ACCT, oauthGrantId: null }, WS]]);
  });

  it('an older host\'s account principal (no grant marker): refused for a team\'s session account, which a grant may be behind', async () => {
    const shared = reach({ sessionAccount: true, accountReaches: true });
    expect(await shared.check({ kind: 'account', id: ACCT }, WS)).toBe(false);
    expect(shared.calls).toEqual([['session?', ACCT]]);
    // Any other account (an API key) keeps working on its row.
    const key = reach({ sessionAccount: false, accountReaches: true });
    expect(await key.check({ kind: 'account', id: ACCT }, WS)).toBe(true);
    expect(key.calls).toEqual([['session?', ACCT], ['account', { id: ACCT, oauthGrantId: null }, WS]]);
  });

  it('a person by membership; no workspace reaches nothing; the system always', async () => {
    const r = reach();
    expect(await r.check({ kind: 'user', id: USER }, WS)).toBe(true);
    expect(r.calls).toEqual([['user', USER, WS]]);
    expect(await r.check(grantP() as KernelPrincipal, null)).toBe(false);
    expect(await r.check({ kind: 'system', id: 'system:auto_merge' }, WS)).toBe(true);
  });

  it('end to end: a grant-narrowed session is refused 403 for a workspace outside its grant, and nothing runs', async () => {
    const r = reach({ accountReaches: true });
    const s = server({ reaches: (p, w) => r.check(p, w) });
    const outside = await s.call(await signed(body({ principal: grantP({ workspaceIds: [OTHER_WS] }), idempotencyKey: 'land:grant-out-1' })));
    expect([outside.status, (await outside.json()).code]).toEqual([403, 'forbidden']);
    expect(s.ran).toEqual([]);
    const inside = await s.call(await signed(body({ principal: grantP(), idempotencyKey: 'land:grant-in-1' })));
    expect(inside.status).toBe(200);
    expect(s.ran).toHaveLength(1);
  });
});

describe('mixed versions fail closed for grant sessions and keep working for everyone else', () => {
  // The principal check of the control plane before grant principals existed, verbatim.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const olderControlPlaneAccepts = (p: Record<string, unknown>) => {
    const { kind, id } = p;
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) return false;
    if (kind === 'user' || kind === 'account') return UUID.test(id);
    return kind === 'system';
  };

  it('a newer host to an older control plane: a grant session is refused as malformed; a plain account and a person still pass', () => {
    expect(olderControlPlaneAccepts(grantP())).toBe(false);
    expect(olderControlPlaneAccepts({ kind: 'account', id: ACCT, grant: null })).toBe(true);
    expect(olderControlPlaneAccepts({ kind: 'user', id: USER })).toBe(true);
  });

  it('an older host to a newer control plane: its unmarked account principal is still well formed', () => {
    expect(commandProblem(body({ principal: { kind: 'account', id: ACCT } }))).toBeNull();
  });
});

describe('the answer', () => {
  it('carries the result, the delivery and its version, and the host that applied it', async () => {
    const s = server();
    const res = await s.call(await signed(body()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      v: 1, op: 'land', idempotencyKey: 'land:key-0001', result: { merged: true, outcome: 'merged' },
      delivery: { id: DELIVERY, version: 9 }, host: 'control-plane', replayed: false,
    });
    expect(s.ran).toEqual([{ op: 'land', input: landInput }]);
  });
});

describe('AC-11: one idempotency key is one execution and one answer', () => {
  it('two concurrent submissions with one key: the command runs once and both callers get the same result and version', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let runs = 0;
    const s = server({
      run: (async () => { runs++; await gate; return { merged: true, outcome: 'merged' }; }) as CommandServerDeps['run'],
      sleep: async () => { release(); await new Promise((r) => setTimeout(r, 1)); },
    });
    const [a, b] = await Promise.all([s.call(await signed(body())), s.call(await signed(body()))]);
    const [ja, jb] = [await a.json(), await b.json()];
    expect(runs).toBe(1);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([ja.replayed, jb.replayed].sort()).toEqual([false, true]);
    const { replayed: _ra, ...ra } = ja;
    const { replayed: _rb, ...rb } = jb;
    expect(ra).toEqual(rb);
    expect(ra.delivery).toEqual({ id: DELIVERY, version: 9 });
  });

  it('a later submission with the key gets the stored answer and runs nothing', async () => {
    const s = server();
    await s.call(await signed(body()));
    const again = await s.call(await signed(body()));
    expect((await again.json()).replayed).toBe(true);
    expect(s.ran).toHaveLength(1);
  });

  it('the key reused for a different request is refused (422), never answered with the other request\'s result', async () => {
    const s = server();
    await s.call(await signed(body()));
    const other = await s.call(await signed(body({ input: { ...landInput, headSha: 'H2' } })));
    expect([other.status, (await other.json()).code]).toEqual([422, 'idempotency_key_reused']);
    expect(s.ran).toHaveLength(1);
  });

  it('a command that throws stores nothing: the same key runs again on retry', async () => {
    let n = 0;
    const s = server({ run: (async () => { if (n++ === 0) throw new Error('db hiccup'); return { merged: true }; }) as CommandServerDeps['run'] });
    const first = await s.call(await signed(body()));
    expect([first.status, (await first.json()).retryable]).toEqual([500, true]);
    const second = await s.call(await signed(body()));
    expect([second.status, (await second.json()).replayed]).toEqual([200, false]);
    expect(n).toBe(2);
  });

  it('a first request still running past the wait answers in_progress (retryable), and runs nothing twice', async () => {
    let t = 0;
    const s = server({ now: () => (t += 10_000), waitMs: 20_000 });
    await s.ledger.claim({ key: 'land:key-0001', op: 'land', principal: `user:${USER}`, requestHash: await requestHash(body() as never), host: 'control-plane', token: 'other-isolate' });
    const res = await s.call(await signed(body()));
    expect([res.status, (await res.json()).code]).toEqual([409, 'in_progress']);
    expect(s.ran).toEqual([]);
  });
});
