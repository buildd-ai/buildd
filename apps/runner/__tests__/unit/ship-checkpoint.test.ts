/**
 * Fail-closed ship checkpoint (path-claim-ownership.md): the full owned set is
 * recomputed from git, drained to the server in bounded chunks with retries,
 * and the ship goes ahead only on an ACK proving complete coverage. A blocked
 * path names its holder; an unreachable or non-answering server is `unknown`,
 * never fail-open.
 *
 * Real git in throwaway repos; the buildd client is a stub.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/ship-checkpoint.test.ts
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runShipCheckpoint, SHIP_CHECKPOINT_ATTEMPTS } from '../../src/ship-checkpoint';

const BLOCKER = 'bbbbbbbb-1111-2222-3333-444444444444';
const GIT = '-c user.email=t@example.com -c user.name=t -c commit.gpgsign=false';
const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });

let tmp: string;
let origin: string;
let work: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ship-'));
  origin = join(tmp, 'origin.git');
  work = join(tmp, 'work');
  sh(tmp, `git init -q --bare -b dev ${origin}`);
  sh(tmp, `git clone -q ${origin} ${work}`);
  sh(work, 'git checkout -q -b dev');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src/a.ts'), 'a\n');
  sh(work, `git add -A && git ${GIT} commit -q -m base && git push -q origin dev`);
  sh(work, 'git checkout -q -b buildd/task-1');
  // A Bash write: never passed through a pre-edit hook.
  writeFileSync(join(work, 'src/from-bash.ts'), 'x\n');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeWorker(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'w1', taskId: 'task-1', branch: 'buildd/task-1', worktreePath: work,
    worktreeBaseRef: 'origin/dev', prBaseRef: 'origin/dev', pathClaimMode: 'enforce', milestones: [],
    ...overrides,
  };
}

/** A server that leases everything except `held`, answering in the new protocol. */
function grantingServer(held: Record<string, string> = {}) {
  const deltas: any[] = [];
  const updateWorker = mock(async (_id: string, u: any) => {
    deltas.push(u.workingSet);
    const d = u.workingSet;
    const blocked = d.add.filter((p: string) => held[p]).map((p: string) => ({ path: p, blockingTaskId: held[p], blockingTaskTitle: 'Other', blockingPath: p }));
    return {
      workingSetAck: {
        generation: d.generation, acquired: d.add.filter((p: string) => !held[p]), blocked, released: d.remove,
        heldCount: 0, applied: true, coverage: blocked.length ? 'blocked' : d.complete ? 'complete' : 'partial',
        ...(d.includeHeld ? { heldPaths: [] } : {}),
      },
    };
  });
  return { updateWorker, deltas };
}

const deps = (updateWorker: any, over: Record<string, unknown> = {}) => ({
  buildd: { updateWorker } as any, addMilestone: () => {}, sleep: async () => {}, ...over,
});

describe('runShipCheckpoint', () => {
  test('a clean set is proven complete, measured against the PR base, Bash writes included', async () => {
    const { updateWorker, deltas } = grantingServer();
    const r = await runShipCheckpoint(makeWorker(), 'pre_push', deps(updateWorker));
    expect(r).toMatchObject({ kind: 'complete', heldCount: 1 });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ add: ['src/from-bash.ts'], remove: [], complete: true, checkpoint: 'pre_push', includeHeld: true });
  });

  test('2,000 changed files drain in bounded chunks and end complete; the proof is for that generation', async () => {
    for (let i = 0; i < 2000; i++) writeFileSync(join(work, `src/f${i}.ts`), `${i}\n`);
    const { updateWorker, deltas } = grantingServer();
    const r = await runShipCheckpoint(makeWorker(), 'completion', deps(updateWorker));
    expect(r).toMatchObject({ kind: 'complete', heldCount: 2001, generation: 1 });
    expect(deltas.length).toBe(5);
    expect(Math.max(...deltas.map(d => d.add.length))).toBeLessThanOrEqual(500);
    expect(deltas.at(-1).complete).toBe(true);
  });

  test('a sibling holding path #1500 refuses the ship and names the holder', async () => {
    for (let i = 0; i < 2000; i++) writeFileSync(join(work, `src/f${i}.ts`), `${i}\n`);
    const { updateWorker } = grantingServer({ 'src/f1500.ts': BLOCKER });
    const r = await runShipCheckpoint(makeWorker(), 'pre_push', deps(updateWorker));
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') {
      expect(r.collision).toMatchObject({ path: 'src/f1500.ts', blockingTaskId: BLOCKER, blockingTaskTitle: 'Other', source: 'pre_push' });
    }
  });

  test('coordinator unreachable at ship: unknown after bounded retries, never fail-open', async () => {
    const updateWorker = mock(() => new Promise(() => {}));
    const milestones: any[] = [];
    const started = Date.now();
    const r = await runShipCheckpoint(makeWorker(), 'pre_push', deps(updateWorker, { deadlineMs: 50, addMilestone: (_w: any, m: any) => milestones.push(m) }));
    expect(r).toMatchObject({ kind: 'unknown', cause: 'timeout', attempts: SHIP_CHECKPOINT_ATTEMPTS });
    expect(updateWorker).toHaveBeenCalledTimes(SHIP_CHECKPOINT_ATTEMPTS);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(milestones.some(m => String(m.label).includes('coverage unknown'))).toBe(true);

    const failing = mock(async () => { throw new Error('ECONNREFUSED'); });
    const r2 = await runShipCheckpoint(makeWorker(), 'completion', deps(failing));
    expect(r2).toMatchObject({ kind: 'unknown', cause: 'error', attempts: SHIP_CHECKPOINT_ATTEMPTS, detail: 'ECONNREFUSED' });
  });

  test('coordinator unavailable then recovers: the retry converges, nothing is offered twice, ship only after the ACK', async () => {
    const { updateWorker: ok, deltas } = grantingServer();
    let calls = 0;
    const flaky = mock(async (id: string, u: any) => {
      calls += 1;
      if (calls === 1) throw new Error('503');
      return ok(id, u);
    });
    const r = await runShipCheckpoint(makeWorker(), 'pre_push', deps(flaky));
    expect(r.kind).toBe('complete');
    expect(calls).toBe(2);
    // The one delta that landed carried the whole set once; the failed attempt leased nothing.
    expect(deltas).toHaveLength(1);
    expect(deltas[0].add).toEqual(['src/from-bash.ts']);
  });

  test('a server that does not answer the delta (older deploy) is unknown, not assumed held', async () => {
    const updateWorker = mock(async () => ({}));
    const r = await runShipCheckpoint(makeWorker(), 'pre_push', deps(updateWorker));
    expect(r).toMatchObject({ kind: 'unknown', cause: 'server_rejected' });
  });

  test('a closed task leases nothing: unknown, never complete', async () => {
    const updateWorker = mock(async (_id: string, u: any) => ({
      workingSetAck: { generation: u.workingSet.generation, acquired: [], blocked: [], released: [], heldCount: 0, applied: false, coverage: 'partial' },
    }));
    const r = await runShipCheckpoint(makeWorker(), 'completion', deps(updateWorker));
    expect(r).toMatchObject({ kind: 'unknown', cause: 'server_rejected' });
  });

  test('a configured base that cannot be resolved is sweep_incomplete: the owned patch is unknown', async () => {
    const { updateWorker } = grantingServer();
    const r = await runShipCheckpoint(makeWorker({ prBaseRef: 'origin/does-not-exist' }), 'pre_push', deps(updateWorker));
    expect(r).toMatchObject({ kind: 'unknown', cause: 'sweep_incomplete' });
    expect(updateWorker).not.toHaveBeenCalled();
  });

  test('a second checkpoint with nothing new is one cheap round trip carrying the proof, and a reverted file is released', async () => {
    const { updateWorker, deltas } = grantingServer();
    const worker = makeWorker();
    await runShipCheckpoint(worker, 'pre_push', deps(updateWorker));
    await runShipCheckpoint(worker, 'completion', deps(updateWorker));
    expect(deltas).toHaveLength(2);
    expect(deltas[1]).toMatchObject({ add: [], remove: [], complete: true, checkpoint: 'completion' });
    expect(deltas[1].includeHeld).toBeUndefined();

    rmSync(join(work, 'src/from-bash.ts'));
    const r = await runShipCheckpoint(worker, 'pre_push', deps(updateWorker));
    expect(deltas[2]).toMatchObject({ add: [], remove: ['src/from-bash.ts'], complete: true });
    expect(r).toMatchObject({ kind: 'complete', heldCount: 0 });
  });

  test('a restart converges: fresh local state, the server held list, and the current sweep agree', async () => {
    // Session 1 leased a.ts (committed) and the Bash write. The runner died.
    writeFileSync(join(work, 'src/a.ts'), 'edited\n');
    sh(work, `git add src/a.ts && git ${GIT} commit -q -m edit`);
    const held: string[] = ['src/a.ts', 'src/from-bash.ts', 'declared/dir'];
    const deltas: any[] = [];
    const updateWorker = mock(async (_id: string, u: any) => {
      deltas.push(u.workingSet);
      const d = u.workingSet;
      for (const p of d.add) if (!held.includes(p)) held.push(p);
      return { workingSetAck: { generation: d.generation, acquired: d.add.filter((p: string) => !held.includes(p)), blocked: [], released: d.remove, heldCount: held.length, applied: true, coverage: d.complete ? 'complete' : 'partial', ...(d.includeHeld ? { heldPaths: [...held] } : {}) } };
    });
    // No persisted working set at all (worst case).
    const r = await runShipCheckpoint(makeWorker({ workingSet: undefined }), 'pre_push', deps(updateWorker));
    expect(r).toMatchObject({ kind: 'complete', heldCount: 2 });
    expect(deltas[0]).toMatchObject({ add: ['src/a.ts', 'src/from-bash.ts'], remove: [], includeHeld: true });
    // The declared directory lease outside the sweep was never "removed".
    expect(deltas.every(d => d.remove.length === 0)).toBe(true);
  });

  test('rebase / base movement: the owned patch is the diff from the NEW merge-base, not the branch history', async () => {
    // The task committed b.ts; dev then moved on with c.ts; the task rebased onto it.
    writeFileSync(join(work, 'src/b.ts'), 'b\n');
    sh(work, `git add -A && git ${GIT} commit -q -m b`);
    sh(work, 'git checkout -q dev');
    writeFileSync(join(work, 'src/c.ts'), 'c\n');
    sh(work, `git add -A && git ${GIT} commit -q -m c && git push -q origin dev`);
    sh(work, 'git checkout -q buildd/task-1');
    sh(work, `git ${GIT} rebase -q origin/dev`);
    const { updateWorker, deltas } = grantingServer();
    const r = await runShipCheckpoint(makeWorker(), 'pre_push', deps(updateWorker));
    expect(r.kind).toBe('complete');
    // b.ts (ours) and the untracked Bash write yes; c.ts (the base's) no.
    expect(deltas[0].add).toEqual(['src/b.ts', 'src/from-bash.ts']);
  });

  test('no worktree: nothing to own, complete without a call', async () => {
    const updateWorker = mock(async () => ({}));
    const r = await runShipCheckpoint(makeWorker({ worktreePath: undefined }), 'pre_push', deps(updateWorker));
    expect(r).toMatchObject({ kind: 'complete', heldCount: 0 });
    expect(updateWorker).not.toHaveBeenCalled();
  });
});
