/**
 * Ownership writes in packages/core/path-claim.ts — acquisition, narrowing and
 * terminal release — against an in-memory model of the three tables.
 *
 * There is no Postgres in a unit run, so the model stands in for the two things
 * the real code relies on:
 *
 *  - `db.batch([...])` is ONE transaction, and its first statement takes a
 *    workspace-scoped advisory lock. The model runs each batch under a
 *    per-workspace mutex, so two batches for one workspace never interleave.
 *  - Each ownership statement is tagged (`-- path_claims:<op>`) and carries a
 *    single JSON argument. The model applies the op's documented semantics to
 *    its tables. The SQL text itself is asserted separately at the bottom, so
 *    a statement that loses its lock or its guard fails here too.
 *
 * What these tests pin is the protocol: a stale pre-read must never be what
 * decides ownership. Races are staged by holding every batch at a barrier
 * until all racers have finished their unlocked reads.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const WS = '00000000-0000-4000-8000-00000000aaaa';
const OTHER_WS = '00000000-0000-4000-8000-00000000bbbb';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const C = '00000000-0000-4000-8000-0000000000c1';

// ── Model state ──────────────────────────────────────────────────────────────

interface TaskRow { id: string; workspaceId: string; status: string; pathManifest: string[] | null; pathDeclaration: any; pathClaimRevision: number }
interface ClaimRow { id: string; workspaceId: string; taskId: string; path: string; claimedAt: number; releasedAt: Date | null }
interface WaiterRow { id: string; workspaceId: string; blockingTaskId: string; waitingTaskId: string; blockedPath: string; registeredAt: Date; notifiedAt: Date | null }
interface WorkerRow { taskId: string; status: string; updatedAt: Date }

const state = {
  tasks: new Map<string, TaskRow>(),
  claims: [] as ClaimRow[],
  waiters: [] as WaiterRow[],
  workers: [] as WorkerRow[],
};
let seq = 0;
const sqlLog: Array<{ tag: string; text: string }> = [];
const batchLog: string[][] = [];

function addTask(id: string, over: Partial<TaskRow> = {}) {
  state.tasks.set(id, { id, workspaceId: WS, status: 'in_progress', pathManifest: null, pathDeclaration: null, pathClaimRevision: 0, ...over });
  state.workers.push({ taskId: id, status: 'running', updatedAt: new Date() });
}
function addClaim(taskId: string, path: string, workspaceId = WS): string {
  const id = `c${++seq}`;
  state.claims.push({ id, workspaceId, taskId, path, claimedAt: seq, releasedAt: null });
  return id;
}
function addWaiter(blockingTaskId: string, waitingTaskId: string, blockedPath: string, notifiedAt: Date | null = null) {
  state.waiters.push({ id: `w${++seq}`, workspaceId: WS, blockingTaskId, waitingTaskId, blockedPath, registeredAt: new Date(), notifiedAt });
}
const active = (taskId: string) => state.claims.filter(c => c.taskId === taskId && !c.releasedAt).map(c => c.path).sort();

// ── Where-clause interpreter for db.query.*.findMany ─────────────────────────

const COLS: Record<string, string> = {
  workspace_id: 'workspaceId', task_id: 'taskId', released_at: 'releasedAt', id: 'id', path: 'path',
  blocking_task_id: 'blockingTaskId', waiting_task_id: 'waitingTaskId', notified_at: 'notifiedAt',
  registered_at: 'registeredAt', blocked_path: 'blockedPath', status: 'status', updated_at: 'updatedAt',
};
function matches(row: any, w: any): boolean {
  if (!w) return true;
  switch (w.type) {
    case 'and': return w.args.filter(Boolean).every((x: any) => matches(row, x));
    case 'eq': return row[COLS[w.a]] === w.b;
    case 'isNull': return row[COLS[w.a]] == null;
    case 'inArray': return w.b.includes(row[COLS[w.a]]);
    case 'lt': return row[COLS[w.a]] < w.b;
    default: throw new Error(`model: unsupported where ${w.type}`);
  }
}
const findMany = (rows: () => any[]) => async (opts?: any) => rows().filter(r => matches(r, opts?.where)).map(r => ({ ...r }));

// ── Ownership statements ─────────────────────────────────────────────────────

const norm = (p: string) => p.replace(/\/+$/, '');
const overlap = (x: string, y: string) => x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
const under = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');

function runOp(tag: string, a: any): { rows: any[] } {
  const now = new Date();
  if (tag === 'lock') return { rows: [{}] };
  if (tag === 'acquire') {
    const task = state.tasks.get(a.taskId);
    const ownerOpen = !!task && task.workspaceId === a.workspaceId && a.openStatuses.includes(task.status);
    const req = [...new Set<string>(a.paths)];
    const blocked: any[] = [];
    for (const p of req) {
      const hit = state.claims
        .filter(c => c.workspaceId === a.workspaceId && !c.releasedAt && c.taskId !== a.taskId && !a.ignoreHolders.includes(c.taskId))
        .sort((x, y) => x.claimedAt - y.claimedAt)
        .find(c => overlap(norm(c.path), p));
      if (hit) blocked.push({ path: p, blockingTaskId: hit.taskId, blockingPath: hit.path });
    }
    const grantable = !ownerOpen ? [] : req.filter(p =>
      !blocked.some(b => b.path === p) && (!a.allOrNothing || blocked.length === 0));
    const inserted: string[] = [];
    const insertedIds: string[] = [];
    for (const p of grantable) {
      if (state.claims.some(c => c.taskId === a.taskId && !c.releasedAt && norm(c.path) === p)) continue;
      insertedIds.push(addClaim(a.taskId, p, a.workspaceId));
      inserted.push(p);
    }
    const declared = a.declare && task ? grantable.filter(p => !(task.pathManifest ?? []).includes(p)).sort() : [];
    if (task && (inserted.length || declared.length)) {
      task.pathDeclaration ??= { declared: task.pathManifest, source: 'runtime', snapshotAt: now.toISOString() };
      if (declared.length) task.pathManifest = [...(task.pathManifest ?? []), ...declared];
      task.pathClaimRevision += 1;
    }
    return { rows: [{ owner_open: ownerOpen, blocked, inserted, inserted_ids: insertedIds, path_manifest: task?.pathManifest ?? null, revision: task?.pathClaimRevision ?? null }] };
  }
  if (tag === 'release') {
    const task = state.tasks.get(a.taskId);
    const rel = state.claims.filter(c => c.taskId === a.taskId && !c.releasedAt);
    for (const c of rel) c.releasedAt = now;
    if (task && rel.length) task.pathClaimRevision += 1;
    const woken = state.waiters.filter(w => w.blockingTaskId === a.taskId && !w.notifiedAt);
    for (const w of woken) w.notifiedAt = now;
    return { rows: [{
      workspace_id: rel[0]?.workspaceId ?? woken[0]?.workspaceId ?? null,
      released_paths: rel.map(c => c.path),
      waiters: woken.map(w => ({ waitingTaskId: w.waitingTaskId, blockedPath: w.blockedPath })),
    }] };
  }
  if (tag === 'release_rows') {
    const task = state.tasks.get(a.taskId);
    const found = !!task && task.workspaceId === a.workspaceId;
    const kept = found && a.keepStatuses.includes(task!.status);
    const rel = !found || kept ? [] : state.claims.filter(c =>
      a.leaseIds.includes(c.id) && c.taskId === a.taskId && c.workspaceId === a.workspaceId && !c.releasedAt);
    for (const c of rel) c.releasedAt = now;
    if (task && rel.length) task.pathClaimRevision += 1;
    const woken = state.waiters.filter(w => w.blockingTaskId === a.taskId && !w.notifiedAt && rel.some(c => norm(c.path) === norm(w.blockedPath)));
    for (const w of woken) w.notifiedAt = now;
    return { rows: [{
      found, kept,
      released_paths: rel.map(c => c.path),
      waiters: woken.map(w => ({ waitingTaskId: w.waitingTaskId, blockedPath: w.blockedPath })),
    }] };
  }
  if (tag === 'narrow') {
    const task = state.tasks.get(a.taskId);
    const found = !!task && task.workspaceId === a.workspaceId;
    const ok = found && (a.expectedRevision == null || task!.pathClaimRevision === a.expectedRevision);
    if (!ok) return { rows: [{ found, revision_ok: false, revision: found ? task!.pathClaimRevision : null, path_manifest: task?.pathManifest ?? null, released_paths: [], waiters: [] }] };
    const drops: string[] = a.paths;
    const hit = (p: string) => drops.some(d => under(norm(p), d));
    const rel = state.claims.filter(c => c.taskId === a.taskId && !c.releasedAt && hit(c.path));
    for (const c of rel) c.releasedAt = now;
    const droppedDecl = (task!.pathManifest ?? []).filter(hit);
    if (rel.length || droppedDecl.length) {
      task!.pathDeclaration ??= { declared: task!.pathManifest, source: 'runtime', snapshotAt: now.toISOString() };
      task!.pathDeclaration = {
        ...task!.pathDeclaration,
        narrowings: [...(task!.pathDeclaration.narrowings ?? []), { at: now.toISOString(), dropped: drops, surface: a.surface, reason: a.reason }].slice(-20),
      };
      if (task!.pathManifest) task!.pathManifest = task!.pathManifest.filter(p => !hit(p));
      task!.pathClaimRevision += 1;
    }
    const woken = state.waiters.filter(w => w.blockingTaskId === a.taskId && !w.notifiedAt && rel.some(c => norm(c.path) === norm(w.blockedPath)));
    for (const w of woken) w.notifiedAt = now;
    return { rows: [{
      found: true, revision_ok: true, revision: task!.pathClaimRevision, path_manifest: task!.pathManifest,
      released_paths: rel.map(c => c.path),
      waiters: woken.map(w => ({ waitingTaskId: w.waitingTaskId, blockedPath: w.blockedPath })),
    }] };
  }
  throw new Error(`model: unknown op ${tag}`);
}

function describeStatement(q: any): { tag: string; args: any; text: string } {
  const text = q.strings.join('$?');
  const m = /--\s*path_claims:(\w+)/.exec(text);
  if (!m) throw new Error(`model: untagged statement: ${text.slice(0, 60)}`);
  const json = q.values.find((v: unknown) => typeof v === 'string' && v.startsWith('{'));
  return { tag: m[1], args: json ? JSON.parse(json) : {}, text };
}

// ── Batch runner: per-workspace mutex + optional race barrier ─────────────────

const locks = new Map<string, Promise<void>>();
let barrier: { need: number; waiting: Array<() => void> } | null = null;
let batchFailure: Error | null = null;

function lockKey(args: any): string {
  return args.workspaceId ?? state.tasks.get(args.taskId)?.workspaceId ?? 'none';
}

async function runBatch(queries: any[]) {
  const described = queries.map(describeStatement);
  batchLog.push(described.map(d => d.tag));
  if (barrier) {
    const b = barrier;
    await new Promise<void>(resolve => {
      b.waiting.push(resolve);
      if (b.waiting.length >= b.need) { barrier = null; b.waiting.forEach(r => r()); }
    });
  }
  if (batchFailure) throw batchFailure;
  if (described[0]?.tag !== 'lock') return described.map(d => runOp(d.tag, d.args));
  const key = lockKey(described[0].args);
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(r => { release = r; });
  locks.set(key, prev.then(() => mine));
  await prev;
  try {
    // Yield between statements so an unserialized implementation would interleave.
    const out: any[] = [];
    for (const d of described) { out.push(runOp(d.tag, d.args)); await Promise.resolve(); }
    return out;
  } finally {
    release();
  }
}

// ── Module mocks ─────────────────────────────────────────────────────────────

const mockInsertValues = mock(async (_v: any) => undefined);
const mockOnConflict = mock(async (_v: any) => undefined);

mock.module('../db/client', () => ({
  db: {
    query: {
      pathClaims: { findMany: findMany(() => state.claims) },
      pathClaimWaiters: { findMany: findMany(() => state.waiters) },
      workers: { findMany: findMany(() => state.workers) },
      tasks: { findMany: findMany(() => [...state.tasks.values()]) },
      missionNotes: { findMany: async () => [] },
    },
    execute: (q: any) => {
      const d = describeStatement(q);
      sqlLog.push({ tag: d.tag, text: d.text });
      // Lazy, like drizzle's PgRaw: only the batch runs it.
      return q;
    },
    batch: (queries: any[]) => runBatch(queries),
    insert: () => ({
      values: (v: any) => {
        mockInsertValues(v);
        const p: any = Promise.resolve(undefined);
        p.onConflictDoUpdate = mockOnConflict;
        return p;
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

mock.module('../db/schema', () => ({
  pathClaims: { workspaceId: 'workspace_id', taskId: 'task_id', releasedAt: 'released_at', id: 'id', path: 'path' },
  pathClaimWaiters: { workspaceId: 'workspace_id', blockingTaskId: 'blocking_task_id', waitingTaskId: 'waiting_task_id', notifiedAt: 'notified_at', id: 'id', registeredAt: 'registered_at', blockedPath: 'blocked_path' },
  missionNotes: { missionId: 'mission_id' },
  workers: { taskId: 'task_id', status: 'status', updatedAt: 'updated_at' },
  tasks: { id: 'id', status: 'status' },
}));

mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ type: 'and', args }),
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  lt: (a: any, b: any) => ({ type: 'lt', a, b }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  sql: Object.assign(
    // `sql.raw` fragments (the spliced outbox CTE) are inlined into the text,
    // as drizzle renders them, so SQL assertions see them.
    (strings: TemplateStringsArray, ...values: any[]) => {
      const out: string[] = [strings[0]];
      const vals: any[] = [];
      values.forEach((v, i) => {
        if (v && v.type === 'raw') out[out.length - 1] += v.text + strings[i + 1];
        else if (v && v.type === 'sql') {
          // A nested fragment (the spliced outbox CTE): inline its text, keep its params.
          out[out.length - 1] += v.strings[0];
          v.strings.slice(1).forEach((str: string, k: number) => { vals.push(v.values[k]); out.push(str); });
          out[out.length - 1] += strings[i + 1];
        }
        else { vals.push(v); out.push(strings[i + 1]); }
      });
      return { type: 'sql', strings: out, values: vals };
    },
    { raw: (text: string) => ({ type: 'raw', text }), identifier: (name: string) => ({ type: 'raw', text: `"${name}"` }) },
  ),
}));

const {
  acquirePathClaims,
  claimObservedPaths,
  acquireObservedPaths,
  narrowPathClaims,
  releaseClaims,
  releaseLeaseRows,
  findStaleClaimHolderTaskIds,
  registerWaiter,
} = await import('../path-claim');

beforeEach(() => {
  state.tasks.clear();
  state.claims = [];
  state.waiters = [];
  state.workers = [];
  sqlLog.length = 0;
  batchLog.length = 0;
  locks.clear();
  barrier = null;
  batchFailure = null;
  mockInsertValues.mockClear();
});

function raceBatches(n: number) {
  barrier = { need: n, waiting: [] };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('acquirePathClaims — exclusive acquisition', () => {
  it('one of two simultaneous directory/file acquisitions wins; the other names the winner', async () => {
    addTask(A);
    addTask(B);
    raceBatches(2);

    const [ra, rb] = await Promise.all([
      acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['apps/web/'], declare: true }),
      acquirePathClaims({ workspaceId: WS, taskId: B, paths: ['apps/web/src/page.tsx'], declare: true }),
    ]);

    // Both unlocked reads saw an empty table; only the locked statement decides.
    const kinds = [ra.kind, rb.kind].sort();
    expect(kinds).toEqual(['acquired', 'conflict']);
    const loser = ra.kind === 'conflict' ? ra : rb;
    const winner = ra.kind === 'conflict' ? B : A;
    expect(loser.kind === 'conflict' && loser.conflict.blockingTaskId).toBe(winner);
    expect(state.claims.filter(c => !c.releasedAt)).toHaveLength(1);
  });

  it('two acquisitions of the same exact file never both win', async () => {
    addTask(A);
    addTask(B);
    raceBatches(2);
    const results = await Promise.all([
      acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/x.ts'], declare: true }),
      acquirePathClaims({ workspaceId: WS, taskId: B, paths: ['src/x.ts'], declare: true }),
    ]);
    expect(results.filter(r => r.kind === 'acquired')).toHaveLength(1);
  });

  it('disjoint paths both acquire', async () => {
    addTask(A);
    addTask(B);
    raceBatches(2);
    const results = await Promise.all([
      acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['apps/web/a.ts'], declare: true }),
      acquirePathClaims({ workspaceId: WS, taskId: B, paths: ['apps/webhook/b.ts'], declare: true }),
    ]);
    expect(results.map(r => r.kind)).toEqual(['acquired', 'acquired']);
  });

  it('a path already in the manifest but never leased still acquires a lease', async () => {
    addTask(A, { pathManifest: ['src/declared.ts'] });

    const r = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/declared.ts'], declare: true });

    expect(r.kind).toBe('acquired');
    expect(active(A)).toEqual(['src/declared.ts']);
    // Not appended twice.
    expect(state.tasks.get(A)!.pathManifest).toEqual(['src/declared.ts']);
  });

  it('is idempotent for a path this task already holds', async () => {
    addTask(A, { pathManifest: ['src/x.ts'] });
    addClaim(A, 'src/x.ts');
    const r = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/x.ts'], declare: true });
    expect(r.kind).toBe('acquired');
    expect(r.kind === 'acquired' && r.inserted).toEqual([]);
    expect(active(A)).toEqual(['src/x.ts']);
    expect(state.tasks.get(A)!.pathClaimRevision).toBe(0);
  });

  it('normalizes trailing separators so `lib/` and `lib` are one lease', async () => {
    addTask(A);
    await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['lib/', 'lib'], declare: true });
    expect(active(A)).toEqual(['lib']);
  });

  it('all-or-nothing: a declaration with one blocked path leases none of it', async () => {
    addTask(A);
    addTask(B);
    addClaim(B, 'src/held.ts');
    const r = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/free.ts', 'src/held.ts'], declare: true });
    expect(r.kind).toBe('conflict');
    expect(active(A)).toEqual([]);
    expect(state.tasks.get(A)!.pathManifest).toBeNull();
  });

  it('a holder in another workspace never blocks', async () => {
    addTask(A);
    addTask(C, { workspaceId: OTHER_WS });
    addClaim(C, 'src/x.ts', OTHER_WS);
    const r = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/x.ts'], declare: true });
    expect(r.kind).toBe('acquired');
  });

  it('a terminal holder does not block a fresh task, even though its row was never released', async () => {
    addTask(A);
    addTask(B, { status: 'cancelled' });
    addClaim(B, 'src/x.ts');
    const r = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/x.ts'], declare: true });
    expect(r.kind).toBe('acquired');
  });

  it('a holder that completed with its PR still open no longer holds an edit lease', async () => {
    addTask(A);
    addTask(B, { status: 'completed' });
    state.workers = state.workers.map(w => w.taskId === B ? { ...w, status: 'completed' } : w);
    addClaim(B, 'src/x.ts');
    const r = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/x.ts'], declare: true });
    // The open-PR backstop in the claim route protects the pending change; the
    // edit lease itself is not what does that.
    expect(r.kind).toBe('acquired');
  });

  it('snapshots the declaration before its first runtime mutation', async () => {
    addTask(A, { pathManifest: ['src/a.ts'] });
    await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/b.ts'], declare: true });
    const t = state.tasks.get(A)!;
    expect(t.pathManifest).toEqual(['src/a.ts', 'src/b.ts']);
    expect(t.pathDeclaration.declared).toEqual(['src/a.ts']);
    expect(t.pathDeclaration.source).toBe('runtime');
    expect(t.pathClaimRevision).toBe(1);
  });
});

describe('acquirePathClaims — late append vs cancellation', () => {
  it('an append that read the task open cannot lease after the cancel committed', async () => {
    addTask(A, { status: 'in_progress' });
    raceBatches(2);

    // The acquisition does its unlocked read while the task is open ...
    const pending = acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/x.ts'], declare: true });
    // ... then the cancel lands: status first, then the terminal release.
    await Promise.resolve();
    state.tasks.get(A)!.status = 'cancelled';
    const released = releaseClaims(A);

    const [r] = await Promise.all([pending, released]);
    expect(r.kind).toBe('task_closed');
    expect(active(A)).toEqual([]);
    expect(state.tasks.get(A)!.pathManifest).toBeNull();
  });

  it('an append that commits first is swept up by the release that follows it', async () => {
    addTask(A);
    const r = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/x.ts'], declare: true });
    expect(r.kind).toBe('acquired');
    state.tasks.get(A)!.status = 'cancelled';
    const rel = await releaseClaims(A);
    expect(rel?.releasedPaths).toEqual(['src/x.ts']);
    expect(active(A)).toEqual([]);
  });

  it('acquisition and release share one lock statement per workspace', async () => {
    addTask(A);
    await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/x.ts'], declare: true });
    await releaseClaims(A);
    await narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['src/x.ts'], surface: 't' });
    expect(batchLog).toEqual([['lock', 'acquire'], ['lock', 'release'], ['lock', 'narrow']]);
  });
});

describe('claimObservedPaths — observed touches use the same acquisition', () => {
  it('leases what is free and refuses what another live task holds', async () => {
    addTask(A);
    addTask(B);
    addClaim(B, 'packages/core/');
    const leased = await claimObservedPaths(WS, A, ['packages/core/x.ts', 'apps/web/y.ts']);
    expect(leased).toEqual(['apps/web/y.ts']);
    expect(active(A)).toEqual(['apps/web/y.ts']);
    expect(state.tasks.get(A)!.pathManifest).toBeNull();
  });

  it('keeps the regenerable-file and sentinel exceptions', async () => {
    addTask(A);
    const leased = await claimObservedPaths(WS, A, ['docs/specs/INDEX.md', 'packages/core/drizzle/meta/_journal.json', '**']);
    expect(leased).toEqual([]);
    expect(batchLog).toEqual([]);
  });

  it('does not treat a migration file as regenerable', async () => {
    addTask(A);
    const leased = await claimObservedPaths(WS, A, ['packages/core/drizzle/0999_x.sql']);
    expect(leased).toEqual(['packages/core/drizzle/0999_x.sql']);
  });

  it('does not lease for a task that is no longer open', async () => {
    addTask(A, { status: 'cancelled' });
    const leased = await claimObservedPaths(WS, A, ['src/x.ts']);
    expect(leased).toEqual([]);
    expect(active(A)).toEqual([]);
  });
});

describe('acquireObservedPaths — a checkpoint sweep learns what it collided with', () => {
  it('returns the leased paths and every observed path another live task holds, with the holder', async () => {
    addTask(A);
    addTask(B);
    addClaim(B, 'packages/core/');
    const r = await acquireObservedPaths(WS, A, ['packages/core/x.ts', 'apps/web/y.ts']);
    expect(r.inserted).toEqual(['apps/web/y.ts']);
    expect(r.blocked).toEqual([{ path: 'packages/core/x.ts', blockingTaskId: B, blockingPath: 'packages/core/' }]);
    // The held path is never leased to the observer.
    expect(active(A)).toEqual(['apps/web/y.ts']);
  });

  it('a terminal holder is not a collision', async () => {
    addTask(A);
    addTask(B, { status: 'cancelled' });
    addClaim(B, 'src/x.ts');
    const r = await acquireObservedPaths(WS, A, ['src/x.ts']);
    expect(r.blocked).toEqual([]);
    expect(r.inserted).toEqual(['src/x.ts']);
  });

  it('regenerable files and the sentinel are neither leased nor collisions', async () => {
    addTask(A);
    addTask(B);
    addClaim(B, 'docs/specs/INDEX.md');
    const r = await acquireObservedPaths(WS, A, ['docs/specs/INDEX.md', '**']);
    expect(r).toEqual({ inserted: [], blocked: [] });
  });

  it('a closed observer leases nothing and reports nothing', async () => {
    addTask(A, { status: 'cancelled' });
    addTask(B);
    addClaim(B, 'src/x.ts');
    expect(await acquireObservedPaths(WS, A, ['src/x.ts'])).toEqual({ inserted: [], blocked: [] });
  });
});

describe('narrowPathClaims — selective release', () => {
  it('releases only the dropped leases (and those under a dropped directory), and shrinks the manifest', async () => {
    addTask(A, { pathManifest: ['apps/web/', 'packages/core/a.ts', 'packages/core/b.ts'] });
    addClaim(A, 'apps/web/src/x.ts');
    addClaim(A, 'packages/core/a.ts');
    addClaim(A, 'packages/core/b.ts');
    addTask(B);
    addClaim(B, 'apps/web/src/other.ts');

    const r = await narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['apps/web', 'packages/core/a.ts'], surface: 'test', reason: 'stale retry scope' });

    expect(r.kind).toBe('narrowed');
    if (r.kind !== 'narrowed') return;
    expect(r.releasedPaths.sort()).toEqual(['apps/web/src/x.ts', 'packages/core/a.ts']);
    expect(active(A)).toEqual(['packages/core/b.ts']);
    // Another task's lease under the same directory is untouched.
    expect(active(B)).toEqual(['apps/web/src/other.ts']);
    const t = state.tasks.get(A)!;
    expect(t.pathManifest).toEqual(['packages/core/b.ts']);
    expect(t.pathDeclaration.declared).toEqual(['apps/web/', 'packages/core/a.ts', 'packages/core/b.ts']);
    expect(t.pathDeclaration.narrowings).toHaveLength(1);
    expect(t.pathDeclaration.narrowings[0]).toMatchObject({ dropped: ['apps/web', 'packages/core/a.ts'], surface: 'test', reason: 'stale retry scope' });
    expect(r.revision).toBe(1);
  });

  it('wakes only waiters blocked on a released path', async () => {
    addTask(A, { pathManifest: ['src/a.ts', 'src/b.ts'] });
    addClaim(A, 'src/a.ts');
    addClaim(A, 'src/b.ts');
    addTask(B);
    addTask(C);
    addWaiter(A, B, 'src/a.ts');
    addWaiter(A, C, 'src/b.ts');

    const r = await narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['src/a.ts'], surface: 'test' });

    expect(r.kind === 'narrowed' && r.waiters).toEqual([{ waitingTaskId: B, blockedPath: 'src/a.ts' }]);
    expect(state.waiters.find(w => w.waitingTaskId === C)!.notifiedAt).toBeNull();
  });

  it('refuses a stale expected revision without changing anything, and reports the current one', async () => {
    addTask(A, { pathManifest: ['src/a.ts'], pathClaimRevision: 3 });
    addClaim(A, 'src/a.ts');
    const r = await narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['src/a.ts'], surface: 't', expectedRevision: 2 });
    expect(r).toMatchObject({ kind: 'revision_conflict', currentRevision: 3 });
    expect(active(A)).toEqual(['src/a.ts']);
  });

  it('a narrowing racing an acquisition serializes: the acquired lease is never silently lost or resurrected', async () => {
    addTask(A, { pathManifest: ['src/a.ts'] });
    addClaim(A, 'src/a.ts');
    raceBatches(2);
    const [acq, nar] = await Promise.all([
      acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/b.ts'], declare: true }),
      narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['src/a.ts'], surface: 't' }),
    ]);
    expect(acq.kind).toBe('acquired');
    expect(nar.kind).toBe('narrowed');
    expect(active(A)).toEqual(['src/b.ts']);
    expect(state.tasks.get(A)!.pathManifest).toEqual(['src/b.ts']);
    expect(state.tasks.get(A)!.pathClaimRevision).toBe(2);
  });

  it('is workspace-scoped: a task in another workspace is not found', async () => {
    addTask(A, { workspaceId: OTHER_WS, pathManifest: ['src/a.ts'] });
    addClaim(A, 'src/a.ts', OTHER_WS);
    const r = await narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['src/a.ts'], surface: 't' });
    expect(r.kind).toBe('not_found');
    expect(active(A)).toEqual(['src/a.ts']);
  });

  it('a no-op narrowing does not bump the revision', async () => {
    addTask(A, { pathManifest: ['src/a.ts'] });
    const r = await narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['src/zzz.ts'], surface: 't' });
    expect(r).toMatchObject({ kind: 'narrowed', releasedPaths: [], revision: 0 });
  });
});

describe('releaseClaims — terminal release', () => {
  it('repeat terminal events release once and wake each waiter once', async () => {
    addTask(A, { status: 'cancelled' });
    addClaim(A, 'src/a.ts');
    addTask(B);
    addWaiter(A, B, 'src/a.ts');

    const first = await releaseClaims(A);
    const second = await releaseClaims(A);

    expect(first?.releasedPaths).toEqual(['src/a.ts']);
    expect(first?.notifiedWaiters).toEqual([B]);
    expect(second).toBeNull();
  });

  it('a waiter re-armed after a failed delivery is woken by the next release event', async () => {
    addTask(A, { status: 'cancelled' });
    addTask(B);
    // Claims already released by an earlier event; delivery then failed and
    // the waiter was re-armed (notifiedAt cleared).
    addWaiter(A, B, 'src/a.ts', null);

    const again = await releaseClaims(A);
    expect(again?.releasedPaths).toEqual([]);
    expect(again?.waiters).toEqual([{ waitingTaskId: B, blockedPath: 'src/a.ts' }]);
  });

  it('bumps the ownership revision so a narrow that read before the release is refused', async () => {
    addTask(A, { pathManifest: ['src/a.ts'] });
    addClaim(A, 'src/a.ts');
    await releaseClaims(A);
    const r = await narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['src/a.ts'], surface: 't', expectedRevision: 0 });
    expect(r.kind).toBe('revision_conflict');
  });
});

describe('releaseLeaseRows — give back exactly the rows one acquisition inserted', () => {
  const KEEP = ['assigned', 'in_progress', 'review'];

  it('acquisition reports the ids of the rows it inserted', async () => {
    addTask(A, { status: 'pending' });
    const r = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/a.ts'], declare: true });
    expect(r.kind).toBe('acquired');
    if (r.kind !== 'acquired') return;
    expect(r.insertedIds).toHaveLength(1);
    expect(state.claims.find(c => c.id === r.insertedIds[0])?.path).toBe('src/a.ts');
  });

  it("a concurrent re-acquire's leases survive: only the given rows are released", async () => {
    addTask(A, { status: 'pending', pathManifest: ['src/a.ts'] });
    const mine = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/a.ts'], declare: true });
    if (mine.kind !== 'acquired') throw new Error('expected acquired');
    // Another claim attempt for the same task leases a different path meanwhile.
    const other = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/b.ts'], declare: true });
    if (other.kind !== 'acquired') throw new Error('expected acquired');

    const out = await releaseLeaseRows({ workspaceId: WS, taskId: A, leaseIds: mine.insertedIds, keepStatuses: KEEP });
    expect(out.kind).toBe('released');
    expect(active(A)).toEqual(['src/b.ts']);
    // The declaration is untouched: this is a lease give-back, not a narrowing.
    expect(state.tasks.get(A)!.pathManifest).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('a lease re-acquired after an earlier give-back is a new row and survives a repeated give-back', async () => {
    addTask(A, { status: 'pending' });
    const first = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/a.ts'], declare: true });
    if (first.kind !== 'acquired') throw new Error('expected acquired');
    await releaseLeaseRows({ workspaceId: WS, taskId: A, leaseIds: first.insertedIds, keepStatuses: KEEP });
    const again = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/a.ts'], declare: true });
    if (again.kind !== 'acquired') throw new Error('expected acquired');
    expect(again.insertedIds).not.toEqual(first.insertedIds);
    await releaseLeaseRows({ workspaceId: WS, taskId: A, leaseIds: first.insertedIds, keepStatuses: KEEP });
    expect(active(A)).toEqual(['src/a.ts']);
  });

  it('keeps the rows when the task is now owned by a live claim (checked inside the locked statement)', async () => {
    addTask(A, { status: 'pending' });
    const r = await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['src/a.ts'], declare: true });
    if (r.kind !== 'acquired') throw new Error('expected acquired');
    state.tasks.get(A)!.status = 'assigned';
    const out = await releaseLeaseRows({ workspaceId: WS, taskId: A, leaseIds: r.insertedIds, keepStatuses: KEEP });
    expect(out.kind).toBe('kept');
    expect(active(A)).toEqual(['src/a.ts']);
  });

  it('wakes only waiters blocked on a released path, never touches another task or workspace', async () => {
    addTask(A, { status: 'cancelled' });
    const mine = addClaim(A, 'src/a.ts');
    addClaim(A, 'src/b.ts');
    const foreign = addClaim(B, 'src/c.ts');
    addTask(B);
    addTask(C);
    addWaiter(A, B, 'src/a.ts');
    addWaiter(A, C, 'src/b.ts');
    const out = await releaseLeaseRows({ workspaceId: WS, taskId: A, leaseIds: [mine, foreign], keepStatuses: KEEP });
    if (out.kind !== 'released') throw new Error('expected released');
    expect(out.result.releasedPaths).toEqual(['src/a.ts']);
    expect(out.result.notifiedWaiters).toEqual([B]);
    expect(active(B)).toEqual(['src/c.ts']);
    expect((await releaseLeaseRows({ workspaceId: OTHER_WS, taskId: A, leaseIds: [mine], keepStatuses: KEEP })).kind).toBe('not_found');
  });

  it('no ids: nothing is executed', async () => {
    addTask(A);
    sqlLog.length = 0;
    expect((await releaseLeaseRows({ workspaceId: WS, taskId: A, leaseIds: [], keepStatuses: KEEP })).kind).toBe('nothing');
    expect(sqlLog).toHaveLength(0);
  });
});

describe('registerWaiter — retries', () => {
  // Regression: the deadlock BFS walked from the waiter, found the very edge
  // being re-registered and reported every retry as a circular wait.
  it('re-registering an existing wait is not a deadlock', async () => {
    addTask(A);
    addTask(B);
    addWaiter(A, B, 'src/a.ts');
    expect(await registerWaiter(A, B, 'src/a.ts', WS)).toEqual({ registered: true });
  });

  it('a real two-task cycle is still a deadlock', async () => {
    addTask(A);
    addTask(B);
    addWaiter(A, B, 'src/a.ts'); // B waits on A
    const r = await registerWaiter(B, A, 'src/b.ts', WS) as any; // A would wait on B
    expect(r.deadlock).toBe(true);
    expect(r.cycle).toEqual([A, B, A]);
  });

  it('a woken (notified) waiter is not part of a cycle', async () => {
    addTask(A);
    addTask(B);
    addWaiter(A, B, 'src/a.ts', new Date()); // B was woken; no longer waiting
    expect(await registerWaiter(B, A, 'src/b.ts', WS)).toEqual({ registered: true });
  });
});

describe('historical stale rows', () => {
  it('names a terminal holder the lifecycle missed so the reaper can release it', async () => {
    addTask(A, { status: 'failed' });
    addClaim(A, 'src/a.ts');
    addTask(B);
    addClaim(B, 'src/b.ts');
    expect(await findStaleClaimHolderTaskIds()).toEqual([A]);
    await releaseClaims(A);
    expect(await findStaleClaimHolderTaskIds()).toEqual([]);
  });

  it('names a terminal blocker with no claims left but a re-armed waiter, until a release wakes it', async () => {
    addTask(A, { status: 'cancelled' });
    addTask(B);
    addWaiter(A, B, 'src/a.ts', null);
    expect(await findStaleClaimHolderTaskIds()).toEqual([A]);
    await releaseClaims(A);
    expect(await findStaleClaimHolderTaskIds()).toEqual([]);
  });

  it('does not name a live blocker just because someone waits on it', async () => {
    addTask(A);
    addClaim(A, 'src/a.ts');
    addTask(B);
    addWaiter(A, B, 'src/a.ts', null);
    expect(await findStaleClaimHolderTaskIds()).toEqual([]);
  });
});

// ── The SQL the model stands in for ──────────────────────────────────────────

describe('ownership SQL', () => {
  async function statementsFor(fn: () => Promise<unknown>) {
    sqlLog.length = 0;
    await fn();
    return sqlLog;
  }

  it('every ownership statement follows the same workspace advisory lock', async () => {
    addTask(A);
    const log = await statementsFor(async () => {
      await acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['x'], declare: true });
      await narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['x'], surface: 't' });
      await releaseClaims(A);
    });
    const locksSql = log.filter(s => s.tag === 'lock').map(s => s.text);
    expect(locksSql).toHaveLength(3);
    for (const t of locksSql) expect(t).toContain("pg_advisory_xact_lock(hashtext('path_claims')");
  });

  it('acquisition re-checks owner status and prefix overlap inside the locked statement', async () => {
    addTask(A);
    const log = await statementsFor(() =>
      acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['x'], declare: true }));
    const acquire = log.find(s => s.tag === 'acquire')!;
    const t = acquire.text.replace(/\s+/g, ' ');
    expect(t).toContain('released_at IS NULL');
    expect(t).toContain("starts_with(req.path, rtrim(pc.path, '/') || '/')");
    expect(t).toContain("starts_with(rtrim(pc.path, '/'), req.path || '/')");
    expect(t).toContain("t.status IN (SELECT jsonb_array_elements_text(a->'openStatuses'))");
    expect(t).toContain('INSERT INTO path_claims');
    expect(t).toContain('path_claim_revision = t.path_claim_revision + 1');
  });

  it('a lease give-back releases by row id, for this task, and re-checks status under the lock', async () => {
    addTask(A, { status: 'pending' });
    const log = await statementsFor(() =>
      releaseLeaseRows({ workspaceId: WS, taskId: A, leaseIds: ['c1'], keepStatuses: ['assigned'] }));
    expect(log.filter(s => s.tag === 'lock').map(s => s.text).join(' ')).toContain("pg_advisory_xact_lock(hashtext('path_claims')");
    const t = log.find(s => s.tag === 'release_rows')!.text.replace(/\s+/g, ' ');
    expect(t).toContain("pc.task_id = (a->>'taskId')::uuid");
    expect(t).toContain("pc.workspace_id = (a->>'workspaceId')::uuid");
    expect(t).toContain('pc.released_at IS NULL');
    expect(t).toContain("pc.id::text IN (SELECT jsonb_array_elements_text(a->'leaseIds'))");
    expect(t).toContain("o.status IN (SELECT jsonb_array_elements_text(a->'keepStatuses'))");
  });

  it('narrowing CASes on the revision and only releases this task', async () => {
    addTask(A);
    const log = await statementsFor(() =>
      narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['x'], surface: 't', expectedRevision: 0 }));
    const narrow = log.find(s => s.tag === 'narrow')!;
    const t = narrow.text.replace(/\s+/g, ' ');
    expect(t).toContain("o.path_claim_revision = (a->>'expectedRevision')::int");
    expect(t).toContain("pc.task_id = (a->>'taskId')::uuid");
    expect(t).toContain("t.workspace_id = (a->>'workspaceId')::uuid");
  });

  it('release, narrow and lease give-back each write the waiters\' wake in the same statement', async () => {
    addTask(A);
    const log = await statementsFor(async () => {
      await narrowPathClaims({ workspaceId: WS, taskId: A, paths: ['x'], surface: 't' });
      await releaseLeaseRows({ workspaceId: WS, taskId: A, leaseIds: ['c1'], keepStatuses: [] });
      await releaseClaims(A);
    });
    for (const tag of ['narrow', 'release_rows', 'release']) {
      const t = log.find(s => s.tag === tag)!.text.replace(/\s+/g, ' ');
      expect(t).toContain('INSERT INTO task_dispatch_outbox');
      expect(t).toContain("FROM \"woken\" s JOIN tasks t ON t.id = s.waiting_task_id WHERE t.status = 'pending'");
      // The cause is a bound parameter now, not text spliced into the statement.
      expect(t).toContain('jsonb_build_array($?::text)');
    }
  });

  it('surfaces a failed batch instead of reporting an acquisition', async () => {
    addTask(A);
    batchFailure = new Error('connection reset');
    await expect(acquirePathClaims({ workspaceId: WS, taskId: A, paths: ['x'], declare: true })).rejects.toThrow('connection reset');
  });
});
