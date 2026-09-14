/**
 * MCP surface for the discrepancy ledger — §13 of
 * docs/design/spec-conformance.md: list_discrepancies, get_discrepancy,
 * adjudicate_discrepancy, promote_discrepancy.
 */
import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const DISCREPANCY_ID = '00000000-0000-0000-0000-0000000000d1';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: DISCREPANCY_ID,
  workspaceId: WS_ID,
  specPath: 'docs/design/worker-mount-isolation.md',
  assertionId: 'mount-symbol',
  direction: 'code_ahead',
  status: 'open',
  firstSeenAt: '2026-08-25T00:00:00.000Z',
  lastCheckedAt: '2026-09-01T00:00:00.000Z',
  acceptedReason: null,
  promotedMissionId: null,
  evidence: { assertionType: 'symbol', outcome: 'pass', detail: 'export found' },
  ...overrides,
});

describe('list_discrepancies', () => {
  it('passes workspaceId and filters through as query params', async () => {
    const mockApi = mock(async () => ({ discrepancies: [row()] })) as unknown as ApiFn;
    const result = await handleBuilddAction(
      mockApi,
      'list_discrepancies',
      { direction: 'code_ahead', status: 'open' },
      ctx(),
    );
    const [endpoint] = (mockApi as any).mock.calls[0];
    expect(endpoint).toContain(`workspaceId=${WS_ID}`);
    expect(endpoint).toContain('direction=code_ahead');
    expect(endpoint).toContain('status=open');
    expect(result.content[0].text).toContain('worker-mount-isolation.md');
  });

  it('reports no discrepancies found for an empty list', async () => {
    const mockApi = mock(async () => ({ discrepancies: [] })) as unknown as ApiFn;
    const result = await handleBuilddAction(mockApi, 'list_discrepancies', {}, ctx());
    expect(result.content[0].text).toBe('No discrepancies found.');
  });

  it('errors without a resolvable workspace', async () => {
    const mockApi = mock(async () => ({})) as unknown as ApiFn;
    await expect(
      handleBuilddAction(
        mockApi,
        'list_discrepancies',
        {},
        ctx({ workspaceId: undefined, getWorkspaceId: async () => null }),
      )
    ).rejects.toThrow(/workspaceId is required/);
  });
});

describe('get_discrepancy', () => {
  it('requires a full UUID discrepancyId', async () => {
    const mockApi = mock(async () => ({})) as unknown as ApiFn;
    await expect(
      handleBuilddAction(mockApi, 'get_discrepancy', { discrepancyId: 'abc' }, ctx())
    ).rejects.toThrow(/full UUID/);
  });

  it('returns the row\'s evidence', async () => {
    const mockApi = mock(async () => ({ discrepancy: row() })) as unknown as ApiFn;
    const result = await handleBuilddAction(mockApi, 'get_discrepancy', { discrepancyId: DISCREPANCY_ID }, ctx());
    expect((mockApi as any).mock.calls[0][0]).toBe(`/api/discrepancies/${DISCREPANCY_ID}`);
    expect(result.content[0].text).toContain('mount-symbol');
    expect(result.content[0].text).toContain('export found');
  });
});

describe('adjudicate_discrepancy', () => {
  it('rejects an unknown action before calling the API', async () => {
    const mockApi = mock(async () => ({})) as unknown as ApiFn;
    await expect(
      handleBuilddAction(
        mockApi,
        'adjudicate_discrepancy',
        { discrepancyId: DISCREPANCY_ID, action: 'bogus' },
        ctx(),
      )
    ).rejects.toThrow(/action must be/);
    expect((mockApi as any).mock.calls.length).toBe(0);
  });

  it('posts accept with reason', async () => {
    const mockApi = mock(async () => ({ discrepancy: row({ status: 'accepted', acceptedReason: 'deferred' }) })) as unknown as ApiFn;
    const result = await handleBuilddAction(
      mockApi,
      'adjudicate_discrepancy',
      { discrepancyId: DISCREPANCY_ID, action: 'accept', reason: 'deferred' },
      ctx(),
    );
    const [endpoint, opts] = (mockApi as any).mock.calls[0];
    expect(endpoint).toBe(`/api/discrepancies/${DISCREPANCY_ID}/adjudicate`);
    expect(JSON.parse(opts.body)).toEqual({ action: 'accept', reason: 'deferred' });
    expect(result.content[0].text).toContain('accepted');
  });

  it('posts flip_direction with newDirection', async () => {
    const mockApi = mock(async () => ({ discrepancy: row({ direction: 'spec_ahead' }) })) as unknown as ApiFn;
    const result = await handleBuilddAction(
      mockApi,
      'adjudicate_discrepancy',
      { discrepancyId: DISCREPANCY_ID, action: 'flip_direction', newDirection: 'spec_ahead', reason: 'confirmed unbuilt' },
      ctx(),
    );
    const [, opts] = (mockApi as any).mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ action: 'flip_direction', reason: 'confirmed unbuilt', newDirection: 'spec_ahead' });
    expect(result.content[0].text).toContain('spec_ahead');
  });
});

describe('promote_discrepancy', () => {
  it('is idempotent when the row is already promoted — no mission is created', async () => {
    const mockApi = mock(async () => ({ discrepancy: row({ direction: 'spec_ahead', promotedMissionId: 'existing-mission' }) })) as unknown as ApiFn;
    const result = await handleBuilddAction(mockApi, 'promote_discrepancy', { discrepancyId: DISCREPANCY_ID }, ctx());
    expect((mockApi as any).mock.calls.length).toBe(1); // only the GET, no POST /api/missions
    expect(result.content[0].text).toContain('Already promoted');
    expect(result.content[0].text).toContain('existing-mission');
  });

  it('rejects a code_ahead row before minting a mission (§8 gate)', async () => {
    const mockApi = mock(async () => ({ discrepancy: row({ direction: 'code_ahead' }) })) as unknown as ApiFn;
    await expect(
      handleBuilddAction(mockApi, 'promote_discrepancy', { discrepancyId: DISCREPANCY_ID }, ctx())
    ).rejects.toThrow(/code_ahead/);
    expect((mockApi as any).mock.calls.length).toBe(1); // only the GET — never called /api/missions
  });

  it('rejects a contradicted row before minting a mission (§8 gate)', async () => {
    const mockApi = mock(async () => ({ discrepancy: row({ direction: 'contradicted' }) })) as unknown as ApiFn;
    await expect(
      handleBuilddAction(mockApi, 'promote_discrepancy', { discrepancyId: DISCREPANCY_ID }, ctx())
    ).rejects.toThrow(/contradicted/);
  });

  it('mints a mission via POST /api/missions, then links it back', async () => {
    const mockApi = mock() as unknown as ApiFn;
    (mockApi as any)
      .mockResolvedValueOnce({ discrepancy: row({ direction: 'spec_ahead' }) }) // GET discrepancy
      .mockResolvedValueOnce({ id: 'mission-1', title: 'Spec discrepancy: mount-symbol in docs/design/worker-mount-isolation.md' }) // POST /api/missions
      .mockResolvedValueOnce({ discrepancy: row({ direction: 'spec_ahead', promotedMissionId: 'mission-1' }), missionId: 'mission-1', alreadyPromoted: false }); // POST promote link

    const result = await handleBuilddAction(mockApi, 'promote_discrepancy', { discrepancyId: DISCREPANCY_ID }, ctx());

    const calls = (mockApi as any).mock.calls;
    expect(calls[0][0]).toBe(`/api/discrepancies/${DISCREPANCY_ID}`);
    expect(calls[1][0]).toBe('/api/missions');
    const missionBody = JSON.parse(calls[1][1].body);
    expect(missionBody.workspaceId).toBe(WS_ID);
    expect(missionBody.title).toContain('mount-symbol');
    expect(calls[2][0]).toBe(`/api/discrepancies/${DISCREPANCY_ID}/promote`);
    expect(JSON.parse(calls[2][1].body)).toEqual({ missionId: 'mission-1' });

    expect(result.content[0].text).toContain('mission-1');
  });
});
