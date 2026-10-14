/**
 * The kernel command endpoint (docs/specs/workflow-kernel-library.md §3,
 * AC-11): who may submit, which host applies, and that one idempotency key is
 * one execution with one answer. The ledger here is an in-memory model of
 * command-ledger.ts's statements; the Postgres ledger runs the same contract
 * under `bun run test:db` (tests/db/kernel-command-host.test.ts).
 */
import { describe, expect, it } from 'bun:test';
import { signRequest } from '@buildd/dispatch-contract';
import { COMMAND_PATH, commandKeyRing, commandProblem, handleCommandRequest, requestHash, type CommandServerDeps } from './command-api';
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

  it('the key ring: a dedicated ring, else one derived from CRON_SECRET under its own label (never the bearer token itself), else empty', () => {
    expect(commandKeyRing({ KERNEL_COMMAND_SECRET: 'a:1,b:2', CRON_SECRET: 'c' })).toEqual({ a: '1', b: '2' });
    const derived = commandKeyRing({ CRON_SECRET: 'cron-secret' });
    expect(Object.keys(derived)).toEqual(['cron']);
    expect(derived.cron).not.toBe('cron-secret');
    expect(commandKeyRing({})).toEqual({});
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
