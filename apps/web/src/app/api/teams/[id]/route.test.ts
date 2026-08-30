import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * `PATCH /api/teams/[id]` — the inference-spending allowlist.
 *
 * Holding an inference key and spending it are separate decisions, so this field
 * differs from `enabledBackends` in one important way: the empty set is legal.
 * "Key stored, nothing enabled" is a state an operator deliberately wants.
 */

let membershipRow: any = { role: 'owner' };
let slugRow: any = null;
const updateCalls: any[] = [];

const mockGetUserFromRequest = mock(() => Promise.resolve({ id: 'user-1' } as any));

mock.module('@/lib/auth-helpers', () => ({
  getUserFromRequest: mockGetUserFromRequest,
}));

mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ __eq: [f, v] }),
  and: (...c: any[]) => ({ __and: c }),
}));

mock.module('@buildd/core/db/schema', () => ({
  teams: { id: 'id', slug: 'slug' },
  teamMembers: { teamId: 'team_id', userId: 'user_id' },
  users: { id: 'id' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findFirst: () => Promise.resolve(membershipRow) },
      teams: { findFirst: () => Promise.resolve(slugRow) },
    },
    update: () => ({
      set: (data: any) => {
        updateCalls.push(data);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));

const { PATCH } = await import('./route');

function patch(body: unknown) {
  return PATCH(
    new NextRequest('http://localhost/api/teams/team-1', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    { params: Promise.resolve({ id: 'team-1' }) },
  );
}

beforeEach(() => {
  membershipRow = { role: 'owner' };
  slugRow = null;
  updateCalls.length = 0;
  mockGetUserFromRequest.mockReset();
  mockGetUserFromRequest.mockReturnValue(Promise.resolve({ id: 'user-1' } as any));
});

describe('PATCH /api/teams/[id] — enabledInferenceCapabilities', () => {
  it('stores a known capability', async () => {
    const res = await patch({ enabledInferenceCapabilities: ['criteria_grading'] });
    expect(res.status).toBe(200);
    expect(updateCalls[0].enabledInferenceCapabilities).toEqual(['criteria_grading']);
  });

  it('accepts the empty set as "key stored, spend nothing" and stores null', async () => {
    const res = await patch({ enabledInferenceCapabilities: [] });
    expect(res.status).toBe(200);
    // Normalised to null so the column has one representation of "none" rather
    // than both NULL and '{}'.
    expect(updateCalls[0].enabledInferenceCapabilities).toBeNull();
  });

  it('accepts explicit null', async () => {
    const res = await patch({ enabledInferenceCapabilities: null });
    expect(res.status).toBe(200);
    expect(updateCalls[0].enabledInferenceCapabilities).toBeNull();
  });

  it('drops a capability this build does not implement', async () => {
    const res = await patch({ enabledInferenceCapabilities: ['criteria_grading', 'wishful_thinking'] });
    expect(res.status).toBe(200);
    // A client from a newer deploy must not be able to switch on spend for a call
    // site that does not exist here.
    expect(updateCalls[0].enabledInferenceCapabilities).toEqual(['criteria_grading']);
  });

  it('rejects a non-array', async () => {
    const res = await patch({ enabledInferenceCapabilities: 'criteria_grading' });
    expect(res.status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  });

  it('leaves the field untouched when it is absent from the body', async () => {
    const res = await patch({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(updateCalls[0].name).toBe('Renamed');
    expect('enabledInferenceCapabilities' in updateCalls[0]).toBe(false);
  });

  it('requires admin', async () => {
    membershipRow = { role: 'member' };
    const res = await patch({ enabledInferenceCapabilities: ['criteria_grading'] });
    // Enabling spend is an admin action; a member must not be able to.
    expect(res.status).toBe(403);
    expect(updateCalls).toHaveLength(0);
  });

  it('requires a session', async () => {
    mockGetUserFromRequest.mockReturnValue(Promise.resolve(null as any));
    const res = await patch({ enabledInferenceCapabilities: ['criteria_grading'] });
    expect(res.status).toBe(401);
    expect(updateCalls).toHaveLength(0);
  });
});

describe('PATCH /api/teams/[id] — enabledBackends is unchanged', () => {
  it('still rejects an empty backend mask', async () => {
    // Unlike the inference allowlist, an empty backend mask would leave nowhere
    // for work to run — the two fields differ on purpose.
    const res = await patch({ enabledBackends: [] });
    expect(res.status).toBe(400);
  });

  it('still accepts a valid backend mask', async () => {
    const res = await patch({ enabledBackends: ['claude'] });
    expect(res.status).toBe(200);
    expect(updateCalls[0].enabledBackends).toEqual(['claude']);
  });
});
