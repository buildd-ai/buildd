/**
 * Which workspaces a team-wide agent model endpoint applies to (`appliesTo`
 * inside the endpoint's encrypted blob): validation, the key-free scope edit,
 * consolidation of per-workspace copies, and the settings readback. Fixtures
 * are illustrative; nothing here is a real key or workspace.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const stored: Array<{ value: string; meta: any }> = [];
const updates: any[] = [];
const deletedIds: string[] = [];
let secretRows: any[] = [];
let teamWorkspaces: any[] = [];
let gateways: Record<string, { baseURL: string; apiKey: string } | null> = {};
let verifyCalls = 0;

mock.module('@buildd/core/db', () => ({
  db: {
    // The only row this file's code updates is the team-wide one: apply it, so
    // the readback after the write sees the new blob as the database would.
    update: () => ({
      set: (v: any) => ({
        where: async () => {
          updates.push(v);
          secretRows = secretRows.map((r) => (r.workspaceId ? r : { ...r, ...v }));
          return [];
        },
      }),
    }),
    delete: () => ({ where: () => ({ returning: async () => [] }) }),
    query: {
      secrets: { findMany: async () => secretRows, findFirst: async () => null },
      workspaces: {
        findFirst: async () => teamWorkspaces[0] ?? null,
        // Returns every workspace, other teams' included: the code must re-check.
        findMany: async () => teamWorkspaces,
      },
      modelTierRegistry: { findMany: async () => [] },
    },
  },
}));
mock.module('@buildd/core/secrets', () => ({
  decrypt: (s: string) => s,
  encrypt: (s: string) => s,
  getSecretsProvider: () => ({
    replaceScoped: async (value: string, meta: any) => { stored.push({ value, meta }); return 's-new'; },
    delete: async (id: string) => { deletedIds.push(id); },
  }),
}));
const realGateway = { ...(await import('@buildd/core/litellm-gateway')) };
mock.module('@buildd/core/litellm-gateway', () => ({
  ...realGateway,
  resolveLiteLLMGateway: async (opts: any) => gateways[opts.workspaceId ?? 'team'] ?? null,
}));

const { setTeamAgentEndpoint, setAgentEndpointAppliesTo, listTeamAgentEndpoints } = await import('./agent-endpoint-settings');

const KEY = 'sk-agent-example-1234';
const OTHER_KEY = 'sk-agent-example-9999';
const URL_A = 'https://litellm.example.com';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const ok = async () => { verifyCalls++; return new Response('{}'); };
const custom = (o: Record<string, unknown> = {}) => JSON.stringify({ kind: 'anthropic-compatible', baseUrl: URL_A, apiKey: KEY, authHeader: 'authorization', ...o });
const row = (id: string, workspaceId: string | null, encryptedValue: string) => ({
  id, workspaceId, accountId: null, userId: null, purpose: 'agent_endpoint', encryptedValue,
  healthStatus: 'healthy', lastVerifiedAt: null, lastVerificationError: null, updatedAt: new Date('2026-01-01'),
});

beforeEach(() => {
  stored.length = 0; updates.length = 0; deletedIds.length = 0; verifyCalls = 0;
  secretRows = []; gateways = {};
  teamWorkspaces = [
    { id: 'ws-a', name: 'Alpha', teamId: 't' },
    { id: 'ws-b', name: 'Bravo', teamId: 't' },
    { id: 'ws-c', name: 'Charlie', teamId: 't' },
    { id: 'ws-x', name: 'Elsewhere', teamId: 'other-team' },
  ];
});

describe('setAgentEndpointAppliesTo: validation', () => {
  beforeEach(() => { secretRows = [row('team', null, custom())]; });

  it('400 when appliesTo is missing, malformed, empty, or consolidate is not a boolean', async () => {
    for (const input of [
      { appliesTo: undefined },
      { appliesTo: 'ws-a' },
      { appliesTo: [] },
      { appliesTo: [3] },
      { appliesTo: ['ws-a'], consolidate: 'yes' },
    ]) {
      expect(await setAgentEndpointAppliesTo({ teamId: 't', ...input })).toMatchObject({ ok: false, status: 400 });
    }
    expect(updates).toHaveLength(0);
  });

  it('400 for a workspace that is not in this team, or does not exist', async () => {
    expect(await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: ['ws-a', 'ws-x'] })).toMatchObject({ ok: false, status: 400 });
    expect(await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: ['ws-gone'] })).toMatchObject({ ok: false, status: 400 });
    expect(updates).toHaveLength(0);
  });

  it('404 with no team-wide endpoint to narrow', async () => {
    secretRows = [row('ws', 'ws-a', custom())];
    expect(await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: ['ws-a'] })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('setAgentEndpointAppliesTo: edits the list without the key', () => {
  it('rewrites only the blob: same key, same URL, no verify call, no new row', async () => {
    secretRows = [row('team', null, custom())];
    const r = await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: ['ws-b', 'ws-a'] });
    expect(r.ok).toBe(true);
    expect(stored).toHaveLength(0);
    expect(verifyCalls).toBe(0);
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0].encryptedValue)).toEqual({
      kind: 'anthropic-compatible', baseUrl: URL_A, apiKey: KEY, authHeader: 'authorization', appliesTo: ['ws-b', 'ws-a'],
    });
    // Health columns untouched: the key did not change.
    expect('healthStatus' in updates[0]).toBe(false);
    if (r.ok) {
      expect(r.endpoint.appliesTo).toEqual([{ id: 'ws-b', name: 'Bravo' }, { id: 'ws-a', name: 'Alpha' }]);
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  });

  it('null widens back to all workspaces', async () => {
    secretRows = [row('team', null, custom({ appliesTo: ['ws-a'] }))];
    const r = await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: null });
    expect(r.ok && r.endpoint.appliesTo).toBeNull();
    expect('appliesTo' in JSON.parse(updates[0].encryptedValue)).toBe(false);
  });
});

describe('setAgentEndpointAppliesTo: consolidating per-workspace copies', () => {
  it('removes a selected workspace\'s identical copy only when asked; keeps one with another key, URL or aliases', async () => {
    secretRows = [
      row('team', null, custom()),
      row('copy-a', 'ws-a', custom()),
      row('diff-key-b', 'ws-b', custom({ apiKey: OTHER_KEY })),
      row('diff-url-c', 'ws-c', custom({ baseUrl: 'https://proxy.example.com' })),
    ];
    const all = ['ws-a', 'ws-b', 'ws-c'];

    const offered = await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: all });
    expect(offered.ok && offered.copies).toEqual([
      { workspaceId: 'ws-a', workspaceName: 'Alpha', matches: true, removed: false },
      { workspaceId: 'ws-b', workspaceName: 'Bravo', matches: false, removed: false },
      { workspaceId: 'ws-c', workspaceName: 'Charlie', matches: false, removed: false },
    ]);
    expect(deletedIds).toEqual([]);

    const done = await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: all, consolidate: true });
    expect(done.ok && done.copies.map((c) => [c.workspaceId, c.removed])).toEqual([['ws-a', true], ['ws-b', false], ['ws-c', false]]);
    expect(deletedIds).toEqual(['copy-a']);
  });

  it('never touches a copy in a workspace the list does not select', async () => {
    secretRows = [row('team', null, custom()), row('copy-a', 'ws-a', custom()), row('copy-b', 'ws-b', custom())];
    const r = await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: ['ws-a'], consolidate: true });
    expect(r.ok && r.copies.map((c) => c.workspaceId)).toEqual(['ws-a']);
    expect(deletedIds).toEqual(['copy-a']);
  });

  it('null (all workspaces) consolidates across every team workspace', async () => {
    secretRows = [row('team', null, custom()), row('copy-a', 'ws-a', custom()), row('copy-c', 'ws-c', custom())];
    await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: null, consolidate: true });
    expect(deletedIds.sort()).toEqual(['copy-a', 'copy-c']);
  });

  it('a copy with different model aliases is kept', async () => {
    secretRows = [row('team', null, custom()), row('copy-a', 'ws-a', custom({ models: { 'claude-sonnet-5': 'team-sonnet' } }))];
    const r = await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: ['ws-a'], consolidate: true });
    expect(r.ok && r.copies[0]).toMatchObject({ matches: false, removed: false });
    expect(deletedIds).toEqual([]);
  });

  it('gateway references match only when they resolve to the same gateway', async () => {
    gateways = { team: { baseURL: `${URL_A}/v1`, apiKey: KEY } };
    secretRows = [row('team', null, JSON.stringify({ kind: 'gateway' })), row('gw-a', 'ws-a', JSON.stringify({ kind: 'gateway' }))];
    // ws-a has no gateway of its own: its reference resolves to the team gateway.
    gateways['ws-a'] = gateways.team;
    gateways['ws-b'] = { baseURL: 'https://other.example.com/v1', apiKey: OTHER_KEY };
    secretRows.push(row('gw-b', 'ws-b', JSON.stringify({ kind: 'gateway' })));
    await setAgentEndpointAppliesTo({ teamId: 't', appliesTo: ['ws-a', 'ws-b'], consolidate: true });
    expect(deletedIds).toEqual(['gw-a']);
  });
});

describe('setTeamAgentEndpoint with appliesTo', () => {
  it('stores a validated list on the team row', async () => {
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'anthropic-compatible', baseUrl: URL_A, apiKey: KEY, appliesTo: ['ws-a'] } }, { lookup: publicLookup, fetcher: ok });
    expect(r.ok && r.endpoint.appliesTo).toEqual([{ id: 'ws-a', name: 'Alpha' }]);
    expect(JSON.parse(stored[0].value).appliesTo).toEqual(['ws-a']);
  });

  it('400 for another team\'s workspace, and for a list on a workspace-scoped row', async () => {
    expect(await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'anthropic-compatible', baseUrl: URL_A, apiKey: KEY, appliesTo: ['ws-x'] } }, { lookup: publicLookup, fetcher: ok }))
      .toMatchObject({ ok: false, status: 400 });
    expect(await setTeamAgentEndpoint({ teamId: 't', workspaceId: 'ws-a', endpoint: { kind: 'anthropic-compatible', baseUrl: URL_A, apiKey: KEY, appliesTo: ['ws-a'] } }, { lookup: publicLookup, fetcher: ok }))
      .toMatchObject({ ok: false, status: 400 });
    expect(stored).toHaveLength(0);
  });

  it('re-saving the endpoint without appliesTo keeps the saved list (never silently widens)', async () => {
    secretRows = [row('team', null, custom({ appliesTo: ['ws-b'] }))];
    const r = await setTeamAgentEndpoint({ teamId: 't', endpoint: { kind: 'anthropic-compatible', baseUrl: URL_A } }, { lookup: publicLookup, fetcher: ok });
    expect(r.ok).toBe(true);
    expect(JSON.parse(stored[0].value)).toMatchObject({ apiKey: KEY, appliesTo: ['ws-b'] });
  });
});

describe('listTeamAgentEndpoints readback', () => {
  it('names the listed workspaces and drops ids that left the team or were deleted', async () => {
    secretRows = [row('team', null, custom({ appliesTo: ['ws-a', 'ws-x', 'ws-gone', 'ws-c'] }))];
    const [team] = await listTeamAgentEndpoints('t');
    expect(team.appliesTo).toEqual([{ id: 'ws-a', name: 'Alpha' }, { id: 'ws-c', name: 'Charlie' }]);
  });

  it('null for an all-workspaces team row; workspace rows say whether they copy the team endpoint', async () => {
    secretRows = [row('team', null, custom()), row('copy-a', 'ws-a', custom()), row('diff-b', 'ws-b', custom({ apiKey: OTHER_KEY }))];
    const list = await listTeamAgentEndpoints('t');
    expect(list.map((e) => [e.id, e.appliesTo, e.matchesTeam])).toEqual([
      ['team', null, false], ['copy-a', null, true], ['diff-b', null, false],
    ]);
    expect(JSON.stringify(list)).not.toContain(KEY);
  });
});
