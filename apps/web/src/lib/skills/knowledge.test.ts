import { describe, it, expect, beforeEach } from 'bun:test';
import { indexSkill, removeSkillChunk, skillKnowledgeDeps } from './knowledge';

const WS = 'ws-synthetic';
const base = {
  id: 'sk1', workspaceId: WS, slug: 'ship-it', name: 'Ship it', description: 'How to ship',
  content: 'Step one.\nStep two.', enabled: true, visibility: 'team', ownerUserId: null,
};

let upserts: Array<{ ns: string; chunks: any[] }>;
let deletes: Array<{ ns: string; sel: any }>;
let stored: string | null;
let failUpsert: boolean;

beforeEach(() => {
  upserts = []; deletes = []; stored = null; failUpsert = false;
  skillKnowledgeDeps.store = async () => ({
    upsert: async (ns: string, chunks: any[]) => { if (failUpsert) throw new Error('embed down'); upserts.push({ ns, chunks }); return { superseded: 0 }; },
    query: async () => [],
    deleteBySource: async (ns: string, sel: any) => { deletes.push({ ns, sel }); },
  } as any);
  skillKnowledgeDeps.storedHash = async () => stored;
  skillKnowledgeDeps.afterResponse = (t) => { void t().catch(() => {}); };
});

describe('indexSkill', () => {
  it('indexes an enabled workspace skill: delete by prefix, then upsert one chunk', async () => {
    const r = await indexSkill(base);
    expect(r.indexed).toBe(true);
    expect(deletes[0]).toEqual({ ns: `${WS}:skill`, sel: { sourceIdPrefix: 'skill:sk1' } });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].chunks).toHaveLength(1);
    expect(upserts[0].chunks[0].id).toBe('skill:sk1');
    expect(upserts[0].chunks[0].content).toContain('Ship it');
    expect(upserts[0].chunks[0].sourceType).toBe('skill');
  });

  it('re-indexes on update when the text changed', async () => {
    await indexSkill(base);
    stored = 'stale';
    const r = await indexSkill({ ...base, content: 'Changed.' });
    expect(r.indexed).toBe(true);
    expect(upserts).toHaveLength(2);
  });

  it('skips embedding when the stored hash matches', async () => {
    const first = await indexSkill(base);
    stored = first.hash!;
    upserts = []; deletes = [];
    const r = await indexSkill(base);
    expect(r.skipped).toBe('unchanged');
    expect(upserts).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  it('drops the chunk when the skill is disabled', async () => {
    const r = await indexSkill({ ...base, enabled: false });
    expect(r.indexed).toBe(false);
    expect(upserts).toHaveLength(0);
    expect(deletes).toHaveLength(1);
  });

  it('never indexes a private or personal role, and writes nothing for it', async () => {
    for (const p of [{ visibility: 'private' }, { ownerUserId: 'u1' }]) {
      const r = await indexSkill({ ...base, ...p });
      expect(r.skipped).toBe('not_indexable');
    }
    expect(upserts).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  it('skips team-level rows (no workspace namespace) on the route hook', async () => {
    const r = await indexSkill({ ...base, workspaceId: null });
    expect(r.skipped).toBe('no_workspace');
    expect(upserts).toHaveLength(0);
  });

  it('fails open on an embed error', async () => {
    failUpsert = true;
    const r = await indexSkill(base);
    expect(r.indexed).toBe(false);
    expect(r.errors[0]).toContain('embed down');
  });
});

describe('removeSkillChunk', () => {
  it('deletes by source prefix and fails open', async () => {
    await removeSkillChunk(WS, 'sk1');
    expect(deletes[0]).toEqual({ ns: `${WS}:skill`, sel: { sourceIdPrefix: 'skill:sk1' } });
    skillKnowledgeDeps.store = async () => { throw new Error('boom'); };
    const r = await removeSkillChunk(WS, 'sk1');
    expect(r.errors[0]).toContain('boom');
  });
});
