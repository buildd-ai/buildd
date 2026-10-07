import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Presence events against an in-memory store that enforces the same
 * invariants the real one gets from Postgres: one presence per
 * (account, client, session hash), one presence per bound worker (unique
 * index), the bind and end compare-and-swaps. The WHERE clauses those CASes
 * and the write throttles use are rendered with the real dialect below, so the
 * stand-in cannot drift from the SQL.
 *
 * `@buildd/core/db` is stubbed so the module loads without a database; any
 * accidental use of it fails the test.
 */

const dbTouched: string[] = [];
mock.module('@buildd/core/db', () => ({
  db: new Proxy({}, { get: (_t, prop) => { dbTouched.push(String(prop)); throw new Error(`db.${String(prop)} used`); } }),
}));

const { parseLocalSessionEvent, normalizeRepoSlug } = await import('@buildd/shared');
const {
  handleLocalSessionEvent,
  hashClientSessionId,
  presenceTouchWhere,
  boundWorkerTouchWhere,
  bindInsertSql,
  LocalSessionError,
} = await import('./local-session');
type Store = import('./local-session').LocalSessionStore;

const dialect = new PgDialect();
const LIVE = new Set(['idle', 'running', 'starting', 'waiting_input']);
const NOW = new Date('2026-10-07T12:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

interface Presence { id: string; accountId: string | null; userId: string | null; kind: string; hash: string; endedAt: Date | null; lastSeenAt: Date; workspaceId: string | null; endReason?: string }
interface Worker { id: string; accountId: string; runner: string; status: string; taskId: string | null; workspaceId: string; updatedAt: Date; pendingInstructions: string | null; ownerTeamId?: string | null; claimUserId?: string | null }

let presences: Presence[];
/** local_session_workers: worker id -> presence id (primary key on the worker). */
let bindings: Map<string, string>;
let workers: Map<string, Worker>;
let workerInserts: number;
let seatWrites: number;
let presenceWrites: number;
let workerTouches: number;
let detachCalls: Array<{ workerId: string; reason: string }>;
let taskStatus: Map<string, string>;

const row = (p: Presence) => ({
  id: p.id,
  endedAt: p.endedAt,
  workerIds: [...bindings].filter(([, pid]) => pid === p.id).map(([wid]) => wid),
});

function memoryStore(): Store {
  let seq = 0;
  return {
    async upsertStart(i) {
      presenceWrites++;
      const same = (x: Presence) => ('userId' in i.owner ? x.userId === i.owner.userId : x.accountId === i.owner.accountId);
      let p = presences.find(x => same(x) && x.kind === i.clientKind && x.hash === i.clientSessionHash);
      if (!p) {
        p = { id: `p${++seq}`, accountId: 'accountId' in i.owner ? i.owner.accountId : null, userId: 'userId' in i.owner ? i.owner.userId : null, kind: i.clientKind, hash: i.clientSessionHash, endedAt: null, lastSeenAt: i.now, workspaceId: i.workspaceId };
        presences.push(p);
      } else {
        p.lastSeenAt = i.now; p.endedAt = null;
        if (i.workspaceId) p.workspaceId = i.workspaceId;
      }
      return row(p);
    },
    async find(owner, kind, hash) {
      const same = (x: Presence) => ('userId' in owner ? x.userId === owner.userId : x.accountId === owner.accountId);
      const p = presences.find(x => same(x) && x.kind === kind && x.hash === hash);
      return p ? row(p) : null;
    },
    async touchPresence(id, now) {
      const p = presences.find(x => x.id === id)!;
      if (p.endedAt || now.getTime() - p.lastSeenAt.getTime() < 60_000) return false;
      p.lastSeenAt = now; presenceWrites++;
      return true;
    },
    async touchBoundWorker(workerId, accountId, now) {
      const w = workers.get(workerId);
      if (!w || (accountId !== null && w.accountId !== accountId) || w.runner !== 'mcp' || !['idle', 'running', 'starting'].includes(w.status)) return false;
      if (now.getTime() - w.updatedAt.getTime() < 60_000) return false;
      w.updatedAt = now; workerTouches++;
      return true;
    },
    async findWorker(id) {
      const w = workers.get(id);
      return w ? { id: w.id, accountId: w.accountId, runner: w.runner, status: w.status, taskId: w.taskId, workspaceId: w.workspaceId, ownerTeamId: w.ownerTeamId ?? 'team-1', claimUserId: w.claimUserId ?? null } : null;
    },
    async bind(presenceId, workerId, workspaceId) {
      const p = presences.find(x => x.id === presenceId)!;
      if (p.endedAt) return false;
      // Primary key on local_session_workers.worker_id: one presence per worker, ever.
      const holder = bindings.get(workerId);
      if (holder && holder !== presenceId) return false;
      bindings.set(workerId, presenceId); p.workspaceId = workspaceId; presenceWrites++;
      return true;
    },
    async end(presenceId, reason, now) {
      const p = presences.find(x => x.id === presenceId)!;
      if (p.endedAt) return null;
      p.endedAt = now; p.endReason = reason; presenceWrites++;
      return row(p);
    },
    async workerState(id) {
      const w = workers.get(id);
      if (!w) return null;
      const live = LIVE.has(w.status);
      return { taskId: w.taskId, pendingInstructions: live && !!w.pendingInstructions, live };
    },
  };
}

/** Mirrors detachInteractiveWorker's contract: CAS out of the live set; never rewrites a terminal task. */
async function detach(workerId: string, reason: string) {
  detachCalls.push({ workerId, reason });
  const w = workers.get(workerId);
  if (!w || w.runner !== 'mcp' || !LIVE.has(w.status)) return { detached: false };
  const ts = w.taskId ? taskStatus.get(w.taskId) : undefined;
  w.status = ts === 'completed' ? 'completed' : 'failed';
  if (w.taskId && ts && !['completed', 'failed', 'cancelled'].includes(ts)) taskStatus.set(w.taskId, 'pending');
  seatWrites++;
  return { detached: true };
}

const ACCOUNT = { id: 'acct-1', teamId: 'team-1' };
const OTHER_ACCOUNT = { id: 'acct-2', teamId: 'team-1' };
let store: Store;
const run = (ev: Record<string, unknown>, account = ACCOUNT, now = NOW) => {
  const parsed = parseLocalSessionEvent({ client: 'claude', clientSessionId: 'sess-A', ...ev });
  if (!parsed.ok) throw new Error(parsed.error);
  return handleLocalSessionEvent(account, parsed.event, { store, now, detach, resolveWorkspace: async () => 'ws-1' });
};

function claimWorker(id = 'w-1', over: Partial<Worker> = {}) {
  // What claim_task's verified interactive claim leaves behind.
  workers.set(id, { id, accountId: ACCOUNT.id, runner: 'mcp', status: 'running', taskId: `t-${id}`, workspaceId: 'ws-1', updatedAt: NOW, pendingInstructions: null, ...over });
  taskStatus.set(`t-${id}`, 'in_progress');
  workerInserts++;
}

beforeEach(() => {
  presences = [];
  bindings = new Map();
  workers = new Map();
  taskStatus = new Map();
  workerInserts = 0;
  seatWrites = 0;
  presenceWrites = 0;
  workerTouches = 0;
  detachCalls = [];
  store = memoryStore();
});

describe('presence', () => {
  it('session start creates presence and consumes zero worker seats', async () => {
    const res = await run({ event: 'start', clientVersion: '2.1.0', repo: 'git@github.com:acme/app.git' });
    expect(res.outcome).toBe('started');
    expect(presences).toHaveLength(1);
    expect(presences[0].workspaceId).toBe('ws-1');
    expect(workerInserts).toBe(0);
    expect(seatWrites).toBe(0);
    expect(workers.size).toBe(0);
    expect(dbTouched).toEqual([]);
  });

  it('stores only a hash of the client session id', async () => {
    await run({ event: 'start' });
    expect(presences[0].hash).toBe(hashClientSessionId('claude', 'sess-A'));
    expect(presences[0].hash).not.toContain('sess-A');
  });

  it('repeated start and touch are idempotent and coalesce to one write a minute', async () => {
    await run({ event: 'start' });
    await run({ event: 'start' });
    expect(presences).toHaveLength(1);
    const before = presenceWrites;
    expect((await run({ event: 'touch' }, ACCOUNT, later(10_000))).outcome).toBe('coalesced');
    expect((await run({ event: 'touch' }, ACCOUNT, later(30_000))).outcome).toBe('coalesced');
    expect(presenceWrites).toBe(before);
    expect((await run({ event: 'touch' }, ACCOUNT, later(61_000))).outcome).toBe('touched');
    expect(presenceWrites).toBe(before + 1);
  });

  it('a touch with no prior start heals into a presence', async () => {
    const res = await run({ event: 'touch' });
    expect(res.outcome).toBe('started');
    expect(presences).toHaveLength(1);
  });

  it('two sessions of one account are separate presences', async () => {
    await run({ event: 'start' });
    await run({ event: 'start', clientSessionId: 'sess-B' });
    expect(presences).toHaveLength(2);
  });
});

describe('bind', () => {
  it('binds an existing presence to exactly one runner=mcp worker, without creating one', async () => {
    await run({ event: 'start' });
    const res = await run({ event: 'bind', workerId: '00000000-0000-4000-8000-000000000001' }).catch(e => e);
    // Unknown id answers not-found (not someone's worker either).
    expect(res).toBeInstanceOf(LocalSessionError);
    expect((res as InstanceType<typeof LocalSessionError>).status).toBe(404);

    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    claimWorker(id);
    const before = workerInserts;
    const ok = await run({ event: 'bind', workerId: id });
    expect(ok.outcome).toBe('bound');
    expect(ok.taskId).toBe(`t-${id}`);
    expect(bindings.get(id)).toBe(presences[0].id);
    expect(workerInserts).toBe(before);
    // Replay is a no-op.
    expect((await run({ event: 'bind', workerId: id })).outcome).toBe('already_bound');
  });

  it('refuses a runner worker and a client-forged mcp-unverified worker', async () => {
    const runnerW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const forged = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    claimWorker(runnerW, { runner: 'runner-host-1' });
    claimWorker(forged, { runner: 'mcp-unverified' });
    for (const id of [runnerW, forged]) {
      const err = await run({ event: 'bind', workerId: id }).catch(e => e);
      expect(err).toBeInstanceOf(LocalSessionError);
      expect(err.code).toBe('not_interactive');
    }
    expect(bindings.size).toBe(0);
  });

  it("refuses another account's worker with the same answer as an unknown id", async () => {
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    claimWorker(id);
    const err = await run({ event: 'bind', workerId: id }, OTHER_ACCOUNT).catch(e => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe('worker_not_found');
  });

  it('a second session cannot bind (and so cannot touch) a worker another session holds', async () => {
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    claimWorker(id);
    await run({ event: 'bind', workerId: id });
    const err = await run({ event: 'bind', workerId: id, clientSessionId: 'sess-B' }).catch(e => e);
    expect(err.code).toBe('bound_elsewhere');
    // Session B's touches never reach the worker.
    workers.get(id)!.updatedAt = NOW;
    await run({ event: 'touch', clientSessionId: 'sess-B' }, ACCOUNT, later(5 * 60_000));
    expect(workers.get(id)!.updatedAt).toEqual(NOW);
  });

  it('one session holds several claims at once (subagents each claiming a task)', async () => {
    const a = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const b = 'bbbbbbbb-0000-4000-8000-00000000000b';
    claimWorker(a);
    claimWorker(b);
    expect((await run({ event: 'bind', workerId: a })).outcome).toBe('bound');
    expect((await run({ event: 'bind', workerId: b })).outcome).toBe('bound');
    expect(bindings.get(a)).toBe(presences[0].id);
    expect(bindings.get(b)).toBe(presences[0].id);
    expect((await run({ event: 'bind', workerId: a })).outcome).toBe('already_bound');
    // Another session still cannot take either.
    expect((await run({ event: 'bind', workerId: b, clientSessionId: 'sess-B' }).catch(e => e)).code).toBe('bound_elsewhere');
  });

  it('refuses a worker that already ended', async () => {
    const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    claimWorker(id, { status: 'completed' });
    expect((await run({ event: 'bind', workerId: id }).catch(e => e)).code).toBe('worker_not_live');
  });
});

describe('touch of a bound worker', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('refreshes exactly the bound worker, coalesced with MCP touches', async () => {
    claimWorker(id);
    const other = '22222222-2222-4222-8222-222222222222';
    claimWorker(other);
    await run({ event: 'bind', workerId: id });
    // An MCP call touched the worker 20s ago: the hook touch coalesces.
    workers.get(id)!.updatedAt = later(40_000);
    await run({ event: 'touch' }, ACCOUNT, later(70_000));
    expect(workerTouches).toBe(0);
    await run({ event: 'touch' }, ACCOUNT, later(200_000));
    expect(workerTouches).toBe(1);
    expect(workers.get(id)!.updatedAt).toEqual(later(200_000));
    expect(workers.get(other)!.updatedAt).toEqual(NOW);
  });

  it('keeps every worker the session holds alive', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    claimWorker(id, { updatedAt: later(-120_000) });
    claimWorker(other, { updatedAt: later(-120_000) });
    await run({ event: 'bind', workerId: id });
    await run({ event: 'bind', workerId: other });
    await run({ event: 'touch' }, ACCOUNT, later(61_000));
    expect(workerTouches).toBe(2);
  });

  it('flags a pending instruction on any held worker, and names that task', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    claimWorker(id);
    claimWorker(other, { pendingInstructions: 'look at the failing test' });
    await run({ event: 'bind', workerId: id });
    await run({ event: 'bind', workerId: other });
    const res = await run({ event: 'touch' }, ACCOUNT, later(120_000));
    expect(res.pendingInstructions).toBe(true);
    expect(res.taskId).toBe(`t-${other}`);
  });

  it('reports a pending instruction as a flag only, never its text', async () => {
    claimWorker(id, { pendingInstructions: 'please rebase on dev' });
    await run({ event: 'bind', workerId: id });
    const res = await run({ event: 'touch' }, ACCOUNT, later(120_000));
    expect(res.pendingInstructions).toBe(true);
    expect(JSON.stringify(res)).not.toContain('rebase');
  });
});

describe('a person presence token', () => {
  // The hooks hold a token for the PERSON, not a team account: their claim may
  // have been made with any of their teams' keys, or over OAuth.
  const PERSON = { kind: 'user' as const, userId: 'user-1', teamIds: ['team-1', 'team-2'] };
  const runAs = (ev: Record<string, unknown>, who: typeof PERSON = PERSON, now = NOW) => {
    const parsed = parseLocalSessionEvent({ client: 'claude', clientSessionId: 'sess-P', ...ev });
    if (!parsed.ok) throw new Error(parsed.error);
    return handleLocalSessionEvent(who, parsed.event, { store, now, detach, resolveWorkspace: async () => 'ws-1' });
  };

  it('start writes a presence owned by the person, no worker, no seat', async () => {
    await runAs({ event: 'start' });
    expect(presences).toHaveLength(1);
    expect(presences[0]).toMatchObject({ userId: 'user-1', accountId: null });
    expect(workerInserts + seatWrites).toBe(0);
  });

  it("binds a worker claimed with another team's key, when the person is in that team", async () => {
    claimWorker('00000000-0000-4000-8000-0000000000b1', { accountId: 'acct-team-2', ownerTeamId: 'team-2' });
    await runAs({ event: 'start' });
    expect((await runAs({ event: 'bind', workerId: '00000000-0000-4000-8000-0000000000b1' })).outcome).toBe('bound');
    // ...and its exit releases it, exactly as for an account-owned presence.
    expect((await runAs({ event: 'end', reason: 'exit' })).outcome).toBe('ended_released');
    expect(taskStatus.get('t-00000000-0000-4000-8000-0000000000b1')).toBe('pending');
  });

  it('refuses, as not found, a worker in a team the person is not in', async () => {
    claimWorker('00000000-0000-4000-8000-0000000000b2', { accountId: 'acct-elsewhere', ownerTeamId: 'team-9' });
    const err = await runAs({ event: 'bind', workerId: '00000000-0000-4000-8000-0000000000b2' }).catch(e => e);
    expect(err).toBeInstanceOf(LocalSessionError);
    expect(err.status).toBe(404);
  });

  it("refuses, as not found, a teammate's claim: the claim records who made it", async () => {
    claimWorker('00000000-0000-4000-8000-0000000000b3', { ownerTeamId: 'team-1', claimUserId: 'user-2' });
    const err = await runAs({ event: 'bind', workerId: '00000000-0000-4000-8000-0000000000b3' }).catch(e => e);
    expect(err.status).toBe(404);
    claimWorker('00000000-0000-4000-8000-0000000000b4', { ownerTeamId: 'team-1', claimUserId: 'user-1' });
    expect((await runAs({ event: 'bind', workerId: '00000000-0000-4000-8000-0000000000b4' })).outcome).toBe('bound');
  });

  it("still refuses a runner's worker", async () => {
    claimWorker('00000000-0000-4000-8000-0000000000b5', { runner: 'runner-host', ownerTeamId: 'team-1' });
    expect((await runAs({ event: 'bind', workerId: '00000000-0000-4000-8000-0000000000b5' }).catch(e => e)).code).toBe('not_interactive');
  });

  it('a touch keeps the bound worker alive whichever account claimed it', async () => {
    claimWorker('00000000-0000-4000-8000-0000000000b1', { accountId: 'acct-team-2', ownerTeamId: 'team-2', updatedAt: later(-120_000) });
    await runAs({ event: 'start' });
    await runAs({ event: 'bind', workerId: '00000000-0000-4000-8000-0000000000b1' });
    await runAs({ event: 'touch' }, PERSON, later(61_000));
    expect(workerTouches).toBe(1);
  });

  it("a person's presence and an account's presence for the same client session are separate rows", async () => {
    await runAs({ event: 'start' });
    await run({ event: 'start', clientSessionId: 'sess-P' });
    expect(presences.map(p => [p.userId, p.accountId])).toEqual([['user-1', null], [null, 'acct-1']]);
  });
});

describe('end', () => {
  const id = '33333333-3333-4333-8333-333333333333';

  it('a presence-only session just ends', async () => {
    await run({ event: 'start' });
    expect((await run({ event: 'end', reason: 'exit' })).outcome).toBe('ended');
    expect(detachCalls).toHaveLength(0);
  });

  it('detaches an unfinished bound task without completing it', async () => {
    claimWorker(id);
    await run({ event: 'bind', workerId: id });
    const res = await run({ event: 'end', reason: 'exit' });
    expect(res.outcome).toBe('ended_released');
    expect(workers.get(id)!.status).toBe('failed');
    expect(taskStatus.get(`t-${id}`)).toBe('pending');
    expect(seatWrites).toBe(1);
  });

  it('exit releases every task the session holds, each exactly once, and a replay changes nothing', async () => {
    const other = '44444444-4444-4444-8444-444444444444';
    claimWorker(id);
    claimWorker(other);
    await run({ event: 'bind', workerId: id });
    await run({ event: 'bind', workerId: other });
    expect((await run({ event: 'end', reason: 'exit' })).outcome).toBe('ended_released');
    expect(taskStatus.get(`t-${id}`)).toBe('pending');
    expect(taskStatus.get(`t-${other}`)).toBe('pending');
    expect(seatWrites).toBe(2);
    expect((await run({ event: 'end', reason: 'exit' })).outcome).toBe('already_ended');
    expect(seatWrites).toBe(2);
    expect(detachCalls.map(c => c.workerId).sort()).toEqual([id, other].sort());
  });

  it('exit with one finished and one open task: the finished one stays finished, the open one goes back', async () => {
    const other = '55555555-5555-4555-8555-555555555555';
    claimWorker(id);
    claimWorker(other);
    await run({ event: 'bind', workerId: id });
    await run({ event: 'bind', workerId: other });
    workers.get(id)!.status = 'completed';
    taskStatus.set(`t-${id}`, 'completed');
    await run({ event: 'end', reason: 'exit' });
    expect(taskStatus.get(`t-${id}`)).toBe('completed');
    expect(taskStatus.get(`t-${other}`)).toBe('pending');
    expect(seatWrites).toBe(1);
  });

  it('clear keeps every claim', async () => {
    const other = '66666666-6666-4666-8666-666666666666';
    claimWorker(id);
    claimWorker(other);
    await run({ event: 'bind', workerId: id });
    await run({ event: 'bind', workerId: other });
    expect((await run({ event: 'end', reason: 'clear' })).outcome).toBe('ended_kept_claim');
    expect(detachCalls).toHaveLength(0);
  });

  it('a completed task with a late end stays completed and releases exactly once', async () => {
    claimWorker(id);
    await run({ event: 'bind', workerId: id });
    taskStatus.set(`t-${id}`, 'completed');
    await run({ event: 'end', reason: 'exit' });
    await run({ event: 'end', reason: 'exit' });
    await run({ event: 'end', reason: 'other' });
    expect(taskStatus.get(`t-${id}`)).toBe('completed');
    expect(workers.get(id)!.status).toBe('completed');
    expect(seatWrites).toBe(1);
    expect(detachCalls).toHaveLength(1);
  });

  it('a worker already completed by complete_task is not released again', async () => {
    claimWorker(id);
    await run({ event: 'bind', workerId: id });
    workers.get(id)!.status = 'completed';
    taskStatus.set(`t-${id}`, 'completed');
    expect((await run({ event: 'end', reason: 'exit' })).outcome).toBe('ended');
    expect(seatWrites).toBe(0);
  });

  it('clear ends the presence but keeps the claim', async () => {
    claimWorker(id);
    await run({ event: 'bind', workerId: id });
    expect((await run({ event: 'end', reason: 'clear' })).outcome).toBe('ended_kept_claim');
    expect(workers.get(id)!.status).toBe('running');
    expect(detachCalls).toHaveLength(0);
  });

  it('an end for a session never seen is a no-op', async () => {
    expect((await run({ event: 'end', reason: 'exit' })).outcome).toBe('unknown_session');
    expect(presences).toHaveLength(0);
  });

  it('a resumed session re-opens its presence', async () => {
    await run({ event: 'start' });
    await run({ event: 'end', reason: 'exit' });
    await run({ event: 'start' }, ACCOUNT, later(60_000));
    expect(presences).toHaveLength(1);
    expect(presences[0].endedAt).toBeNull();
  });
});

describe('contract', () => {
  it('rejects unknown fields so no content can ride along', () => {
    for (const extra of [{ prompt: 'hi' }, { transcript: '...' }, { last_assistant_message: 'x' }]) {
      const r = parseLocalSessionEvent({ event: 'touch', client: 'claude', clientSessionId: 's', ...extra });
      expect(r.ok).toBe(false);
    }
  });

  it('validates vocabulary and per-event fields', () => {
    expect(parseLocalSessionEvent({ event: 'nope', client: 'claude', clientSessionId: 's' }).ok).toBe(false);
    expect(parseLocalSessionEvent({ event: 'start', client: 'vim', clientSessionId: 's' }).ok).toBe(false);
    expect(parseLocalSessionEvent({ event: 'bind', client: 'claude', clientSessionId: 's' }).ok).toBe(false);
    expect(parseLocalSessionEvent({ event: 'touch', client: 'claude', clientSessionId: 's', workerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }).ok).toBe(false);
    expect(parseLocalSessionEvent({ event: 'end', client: 'claude', clientSessionId: 's', reason: 'kill' }).ok).toBe(false);
    const ok = parseLocalSessionEvent({ event: 'end', client: 'codex', clientSessionId: 's' });
    expect(ok.ok && ok.event.reason).toBe('other');
  });

  it('normalizes repos and strips credentials', () => {
    expect(normalizeRepoSlug('https://user:tok@github.com/acme/app.git')).toBe('acme/app');
    expect(normalizeRepoSlug('git@github.com:acme/app.git')).toBe('acme/app');
    expect(normalizeRepoSlug('ssh://git@github.com/acme/app')).toBe('acme/app');
    expect(normalizeRepoSlug('acme/app')).toBe('acme/app');
    expect(normalizeRepoSlug('not a repo')).toBeNull();
    const r = parseLocalSessionEvent({ event: 'start', client: 'claude', clientSessionId: 's', repo: 'https://x:secret@github.com/acme/app' });
    expect(r.ok && r.event.repo).toBe('acme/app');
  });
});

describe('SQL', () => {
  const render = (w: any) => dialect.sqlToQuery(w);

  it('presence touch is coalesced and never revives an ended row', () => {
    const q = render(presenceTouchWhere('p1', NOW));
    expect(q.sql).toContain('"local_sessions"."ended_at" is null');
    expect(q.sql).toContain('"local_sessions"."last_seen_at" <');
    expect(q.params).toContain(new Date(NOW.getTime() - 60_000).toISOString());
  });

  it('bound worker touch is the same guard as the MCP touch: own account, interactive, live, a minute stale', () => {
    const q = render(boundWorkerTouchWhere('w1', 'acct-1', NOW));
    expect(q.sql).toContain('"workers"."account_id" =');
    expect(q.sql).toContain('"workers"."runner" =');
    expect(q.sql).toContain('"workers"."updated_at" <');
    expect(q.params).toContain('mcp');
    expect(q.params).toContain('acct-1');
    expect(q.params).toContain(new Date(NOW.getTime() - 60_000).toISOString());
  });

  it("a person's bound worker touch drops only the account guard: still interactive, live and a minute stale", () => {
    const q = render(boundWorkerTouchWhere('w1', null, NOW));
    expect(q.sql).not.toContain('"workers"."account_id"');
    expect(q.sql).toContain('"workers"."runner" =');
    expect(q.sql).toContain('"workers"."status" in');
    expect(q.sql).toContain('"workers"."updated_at" <');
  });

  it('bind inserts one row per worker, only into an open presence, never stealing another presence\'s worker', () => {
    const q = render(bindInsertSql('p1', 'w1', NOW));
    expect(q.sql).toMatch(/INSERT INTO "local_session_workers"/);
    expect(q.sql).toMatch(/"ended_at" IS NULL/);
    expect(q.sql).toMatch(/ON CONFLICT \("worker_id"\) DO NOTHING/);
    // A session bound before multi-claim keeps its worker: the legacy column still guards it.
    expect(q.sql).toMatch(/"bound_worker_id" = /);
    expect(q.params).toEqual(expect.arrayContaining(['p1', 'w1']));
  });
});
