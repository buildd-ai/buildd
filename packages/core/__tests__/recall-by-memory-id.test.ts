/**
 * `recall` id= is the pull half of claim-time index injection (task caa30c0f):
 * the index shows `m:<8-char id>`, the agent passes that back, and gets the
 * full body. The prefix is resolved inside the caller's own project only, a
 * foreign id and a missing one read identically, and every successful fetch is
 * a `via: pull` row in memory_uses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { handleRecallAction } from '../mcp-tools';
import { setDefaultMemoryLedger, type MemoryUseRow, type MemoryLedgerWriter } from '../memory-retrieval';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const WORKER = '44444444-4444-4444-8444-444444444444';
const OWN = 'acme/widgets';
const FOREIGN = 'acme/other';

const OWN_ID = '1a2b3c4d-0000-4000-8000-000000000001';
const OWN_TWIN_A = '9f9f9f9f-0000-4000-8000-00000000000a';
const OWN_TWIN_B = '9f9f9f9f-0000-4000-8000-00000000000b';
const FOREIGN_ID = '5e6f7a8b-0000-4000-8000-000000000002';

type Row = { id: string; project: string | null; title: string; content: string; type: string };
const ROWS: Row[] = [
  { id: OWN_ID, project: OWN, title: 'Neon has no transactions', content: 'Use UPDATE ... WHERE with returning().', type: 'gotcha' },
  { id: OWN_TWIN_A, project: OWN, title: 'Twin A', content: 'a', type: 'pattern' },
  { id: OWN_TWIN_B, project: OWN, title: 'Twin B', content: 'b', type: 'pattern' },
  { id: FOREIGN_ID, project: FOREIGN, title: 'Secret', content: 'secret content', type: 'decision' },
];

function memStore() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const full = (r: Row) => ({ tags: [], files: [], source: null, ...r });
  return {
    calls,
    async get(id: string) {
      calls.push({ method: 'get', args: [id] });
      const r = ROWS.find(x => x.id === id);
      if (!r) throw new Error(`Memory not found: ${id}`);
      return { memory: full(r) };
    },
    // Mirrors MemoryStore.findByIdPrefix: team + project + prefix, capped.
    async findByIdPrefix(prefix: string, project: string, limit = 2) {
      calls.push({ method: 'findByIdPrefix', args: [prefix, project, limit] });
      return ROWS.filter(r => r.project === project && r.id.startsWith(prefix)).slice(0, limit).map(full);
    },
    async batch(ids: string[]) { return { memories: ROWS.filter(r => ids.includes(r.id)).map(full) }; },
  };
}

const ctx = { workspaceId: WS, teamId: TEAM, project: OWN, workerId: WORKER, embedder: null as any };

let batches: MemoryUseRow[][] = [];
let previous: MemoryLedgerWriter;
beforeEach(() => {
  batches = [];
  previous = setDefaultMemoryLedger(rows => { batches.push(rows); });
});
afterEach(() => { setDefaultMemoryLedger(previous); });

describe('recall id= accepts the index short id', () => {
  it('returns the full body for an 8-char prefix in the caller project', async () => {
    const mc = memStore();
    const res = await handleRecallAction(mc as any, { id: OWN_ID.slice(0, 8) }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('# Neon has no transactions');
    expect(res.content[0].text).toContain('Use UPDATE ... WHERE with returning().');
    // Scoped to the caller's project in the lookup itself.
    expect(mc.calls[0]).toEqual({ method: 'findByIdPrefix', args: [OWN_ID.slice(0, 8), OWN, 2] });
  });

  it('accepts the id as the index writes it: m:<prefix>', async () => {
    const res = await handleRecallAction(memStore() as any, { id: `m:${OWN_ID.slice(0, 8)}` }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Neon has no transactions');
  });

  it('still accepts a full id', async () => {
    const mc = memStore();
    const res = await handleRecallAction(mc as any, { id: OWN_ID }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Neon has no transactions');
    expect(mc.calls[0].method).toBe('get');
  });

  it('a foreign prefix, a foreign full id and a missing id read identically', async () => {
    const foreignPrefix = FOREIGN_ID.slice(0, 8);
    const missingPrefix = 'deadbeef';
    const a = await handleRecallAction(memStore() as any, { id: foreignPrefix }, ctx);
    const b = await handleRecallAction(memStore() as any, { id: missingPrefix }, ctx);
    const c = await handleRecallAction(memStore() as any, { id: FOREIGN_ID }, ctx);
    const d = await handleRecallAction(memStore() as any, { id: 'deadbeef-0000-4000-8000-000000000009' }, ctx);
    for (const [res, id] of [[a, foreignPrefix], [b, missingPrefix], [c, FOREIGN_ID], [d, 'deadbeef-0000-4000-8000-000000000009']] as const) {
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(`Memory not found: ${id}`);
    }
    expect(JSON.stringify([a, b, c, d])).not.toContain('secret content');
    expect(batches).toHaveLength(0);
  });

  it('an ambiguous prefix inside the caller project asks for more characters', async () => {
    const res = await handleRecallAction(memStore() as any, { id: '9f9f9f9f' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('more than one memory');
    expect(res.content[0].text).not.toContain('Twin');
  });

  it('with no project key there is no prefix lookup at all', async () => {
    const mc = memStore();
    const res = await handleRecallAction(mc as any, { id: OWN_ID.slice(0, 8) }, { ...ctx, project: undefined });
    expect(res.isError).toBe(true);
    expect(mc.calls).toHaveLength(0);
  });
});

describe('recall id= records a pull', () => {
  it('writes one via=pull row for the memory it returned', async () => {
    await handleRecallAction(memStore() as any, { id: OWN_ID.slice(0, 8) }, ctx);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([{
      teamId: TEAM,
      workspaceId: WS,
      taskId: null,
      workerId: WORKER,
      chunkId: OWN_ID,
      memoryId: OWN_ID,
      caller: 'recall',
      via: 'pull',
      rank: 1,
      score: null,
      gatedBy: null,
    }]);
  });

  it('uses the context ledger when one is injected', async () => {
    const own: MemoryUseRow[][] = [];
    await handleRecallAction(memStore() as any, { id: OWN_ID }, { ...ctx, memoryLedger: rows => { own.push(rows); } });
    expect(own).toHaveLength(1);
    expect(own[0][0].via).toBe('pull');
    expect(batches).toHaveLength(0);
  });
});
