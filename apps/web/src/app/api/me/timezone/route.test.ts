import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockRecordUserTimezone = mock((_u: string, _tz: string) =>
  Promise.resolve({ timezone: 'America/Chicago', seededTeamIds: [] as string[] }),
);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-timezone', () => ({ recordUserTimezone: mockRecordUserTimezone }));

import { PUT } from './route';

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/me/timezone', {
    method: 'PUT',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockRecordUserTimezone.mockReset();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockRecordUserTimezone.mockResolvedValue({ timezone: 'America/Chicago', seededTeamIds: [] });
});

describe('PUT /api/me/timezone', () => {
  it('returns 401 when not signed in', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await PUT(req({ timezone: 'America/Chicago' }));
    expect(res.status).toBe(401);
    expect(mockRecordUserTimezone).not.toHaveBeenCalled();
  });

  it('persists a detected zone for the signed-in user only', async () => {
    const res = await PUT(req({ timezone: 'America/Chicago' }));
    expect(res.status).toBe(200);
    expect(mockRecordUserTimezone).toHaveBeenCalledWith('user-1', 'America/Chicago');
    expect(await res.json()).toEqual({ timezone: 'America/Chicago', seededTeamIds: [] });
  });

  it('reports which owned teams got seeded', async () => {
    mockRecordUserTimezone.mockResolvedValue({ timezone: 'Europe/Berlin', seededTeamIds: ['team-1'] });
    const res = await PUT(req({ timezone: 'Europe/Berlin' }));
    expect((await res.json()).seededTeamIds).toEqual(['team-1']);
  });

  it('rejects a zone the runtime does not recognise', async () => {
    mockRecordUserTimezone.mockResolvedValue(null);
    const res = await PUT(req({ timezone: 'Mars/Olympus' }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing or non-string timezone without touching the store', async () => {
    for (const body of [{}, { timezone: 42 }, { timezone: '' }]) {
      const res = await PUT(req(body));
      expect(res.status).toBe(400);
    }
    expect(mockRecordUserTimezone).not.toHaveBeenCalled();
  });

  it('returns 400 rather than throwing on a malformed body', async () => {
    const bad = new NextRequest('http://localhost:3000/api/me/timezone', {
      method: 'PUT',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: 'not json',
    });
    const res = await PUT(bad);
    expect(res.status).toBe(400);
  });
});
