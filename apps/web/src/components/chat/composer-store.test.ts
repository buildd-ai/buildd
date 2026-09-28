import { beforeEach, describe, expect, it } from 'bun:test';
import {
  applySeed, chooseComposerTier, chooseComposerWorkspace, getComposerState, resetComposerStore,
  seedComposerStore, setComposerDraft, type ComposerState,
} from './composer-store';

const calls: Array<{ url: string; method: string; body: unknown }> = [];
let seed: unknown = { workspaceId: 'ws-1', tier: 'premium' };
let release: () => void = () => {};

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
  if ((init?.method ?? 'GET') === 'GET') await new Promise<void>(r => { release = r; });
  return new Response(JSON.stringify(init?.method === 'PATCH' ? { ok: true } : seed), { status: 200 });
}) as typeof fetch;

beforeEach(() => { resetComposerStore(); calls.length = 0; seed = { workspaceId: 'ws-1', tier: 'premium' }; });

const base: ComposerState = { teamId: 't', draft: '', workspaceId: null, tier: null, seeded: false, touched: { workspaceId: false, tier: false } };

describe('applySeed', () => {
  it('takes the remembered workspace and tier', () => {
    expect(applySeed(base, { workspaceId: 'ws-1', tier: 'premium' })).toMatchObject({ workspaceId: 'ws-1', tier: 'premium', seeded: true });
  });

  it('never overwrites a field already picked', () => {
    const s = { ...base, workspaceId: 'ws-2', tier: 'budget' as const, touched: { workspaceId: true, tier: true } };
    expect(applySeed(s, { workspaceId: 'ws-1', tier: 'premium' })).toMatchObject({ workspaceId: 'ws-2', tier: 'budget' });
  });

  it('no remembered workspace leaves the current one', () => {
    expect(applySeed({ ...base, workspaceId: 'ws-2' }, { tier: null }).workspaceId).toBe('ws-2');
  });
});

describe('the shared store', () => {
  it('seeds once per team, and a choice made while seeding wins', async () => {
    const p = seedComposerStore('t');
    void seedComposerStore('t');
    chooseComposerTier('t', 'budget');
    release();
    await p;
    expect(calls.filter(c => c.method === 'GET')).toHaveLength(1);
    expect(getComposerState()).toMatchObject({ teamId: 't', workspaceId: 'ws-1', tier: 'budget', seeded: true });
    expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ teamId: 't', tier: 'budget' });
  });

  it('a draft and a workspace survive between composers, never across teams', async () => {
    setComposerDraft('t', 'ship the thing');
    chooseComposerWorkspace('t', null);
    expect(getComposerState()).toMatchObject({ draft: 'ship the thing', workspaceId: null });
    expect(calls.at(-1)?.body).toEqual({ teamId: 't', workspaceId: null });
    setComposerDraft('t2', '');
    expect(getComposerState()).toMatchObject({ teamId: 't2', draft: '', seeded: false });
  });
});
