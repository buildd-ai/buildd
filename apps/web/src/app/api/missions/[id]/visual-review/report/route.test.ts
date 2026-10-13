import { beforeEach, describe, expect, it, mock } from 'bun:test';

const MID = '11111111-1111-4111-8111-111111111111';
let user: { id: string; email: string } | null = { id: 'u1', email: 'owner@example.com' };
let teamIds = ['t1'];
const posted: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: { query: { missions: { findFirst: async () => ({ id: MID, teamId: 't1' }) } } },
}));
mock.module('@buildd/core/db/schema', () => ({ missions: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: () => ({}) }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => user }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: async () => teamIds }));
mock.module('@/lib/mission-feed', () => ({ postMissionFeedEvent: async (o: any) => { posted.push(o); } }));
mock.module('@/lib/workflow/visual-review-state-load', () => ({
  getMissionVisualReviewState: async () => ({
    status: 'blocked', policy: { mode: 'automatic' }, blocked: { cause: 'auditor_failed', causeOwner: 'buildd', autoRetriesLeft: 0 },
    branch: { integrationPr: { number: 4, stage: 'open' }, headSha: 'abc1234', base: 'dev' }, staleEvidence: false, scope: { screens: null },
  }),
}));

const { POST } = await import('./route');
const call = () => POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ url: 'https://x?token=secret' }) }), { params: Promise.resolve({ id: MID }) });

beforeEach(() => { posted.length = 0; user = { id: 'u1', email: 'owner@example.com' }; teamIds = ['t1']; });

describe('POST /api/missions/[id]/visual-review/report', () => {
  it('files a sanitized note built from state, ignoring the request body', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(posted).toHaveLength(1);
    expect(posted[0].title).toBe('Visual review problem reported');
    expect(posted[0].body).not.toMatch(/secret|https?:|abc1234/);
    expect(JSON.parse(posted[0].body)).toMatchObject({ cause: 'auditor_failed', causeOwner: 'buildd', retriesLeft: 0 });
  });
  it('401 signed out, 404 for another team', async () => {
    user = null;
    expect((await call()).status).toBe(401);
    user = { id: 'u1', email: 'a@b.c' }; teamIds = ['other'];
    expect((await call()).status).toBe(404);
    expect(posted).toHaveLength(0);
  });
});
