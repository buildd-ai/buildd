import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * Chat-turn thumbs (docs/design/tier-model-pools.md): owner-only, the
 * conversation's team, a reason label on a down vote, and never any text.
 */

let currentUser: { id: string } | null = { id: 'user-1' };
let turnTeam: string | null = 'team-conv';
let existing: any = null;
const inserted: any[] = [];
const updated: any[] = [];
let deleted = 0;

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => currentUser }));
// Workspace access: which workspaces user-1 can reach, and in which team.
let access: Record<string, string> = { 'ws-mine': 'team-mine' };
let entityWorkspace: string | null = 'ws-mine';
const resolvedRefs: Array<{ entityType: string; entityId: string }> = [];
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['team-first'],
  verifyWorkspaceAccess: async (_userId: string, wsId: string) =>
    access[wsId] ? { teamId: access[wsId], role: 'member' } : null,
}));
mock.module('@/lib/feedback-entity-workspace', () => ({
  resolveFeedbackEntityWorkspace: async (entityType: string, entityId: string) => {
    resolvedRefs.push({ entityType, entityId });
    return entityWorkspace;
  },
}));
mock.module('@/lib/chat/turn-feedback', () => ({ rateableTurnTeam: async () => turnTeam }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { userFeedback: { findFirst: async () => existing, findMany: async () => (existing ? [existing] : []) } },
    insert: () => ({ values: (v: any) => ({ returning: async () => { inserted.push(v); return [v]; } }) }),
    update: () => ({ set: (v: any) => ({ where: () => ({ returning: async () => { updated.push(v); return [v]; } }) }) }),
    delete: () => ({ where: async () => { deleted++; } }),
  },
}));

const { POST, GET } = await import('./route');

const MSG = '0f6c2a10-0000-4000-8000-00000000c0de';
const post = (body: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/feedback', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
}));

beforeEach(() => {
  currentUser = { id: 'user-1' };
  turnTeam = 'team-conv';
  existing = null;
  inserted.length = 0;
  updated.length = 0;
  deleted = 0;
  access = { 'ws-mine': 'team-mine' };
  entityWorkspace = 'ws-mine';
  resolvedRefs.length = 0;
});

describe('POST /api/feedback — conversation_message', () => {
  it('records a thumbs-up under the conversation\'s team', async () => {
    const res = await post({ entityType: 'conversation_message', entityId: MSG, signal: 'up' });
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ teamId: 'team-conv', entityType: 'conversation_message', entityId: MSG, signal: 'up', reason: null, comment: null });
  });

  it('records a down vote with a reason label and drops any comment text', async () => {
    const res = await post({ entityType: 'conversation_message', entityId: MSG, signal: 'down', reason: 'made_up', comment: 'free text' });
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ signal: 'down', reason: 'made_up', comment: null });
  });

  it('rejects an unknown reason, a reason on an up vote, and dismiss', async () => {
    expect((await post({ entityType: 'conversation_message', entityId: MSG, signal: 'down', reason: 'rude' })).status).toBe(400);
    expect((await post({ entityType: 'conversation_message', entityId: MSG, signal: 'up', reason: 'made_up' })).status).toBe(400);
    expect((await post({ entityType: 'conversation_message', entityId: MSG, signal: 'dismiss' })).status).toBe(400);
    expect(inserted).toEqual([]);
  });

  it('404s a turn the user does not own', async () => {
    turnTeam = null;
    expect((await post({ entityType: 'conversation_message', entityId: MSG, signal: 'up' })).status).toBe(404);
    expect(inserted).toEqual([]);
  });

  it('adding a reason to an existing down vote updates it rather than toggling off', async () => {
    existing = { id: 'fb-1', signal: 'down', reason: null };
    const res = await post({ entityType: 'conversation_message', entityId: MSG, signal: 'down', reason: 'wrong_answer' });
    expect(res.status).toBe(200);
    expect(updated[0]).toMatchObject({ signal: 'down', reason: 'wrong_answer' });
    expect(deleted).toBe(0);
  });

  it('the same vote again toggles it off', async () => {
    existing = { id: 'fb-1', signal: 'up', reason: null };
    const res = await post({ entityType: 'conversation_message', entityId: MSG, signal: 'up' });
    expect(await res.json()).toMatchObject({ removed: true });
    expect(deleted).toBe(1);
  });

  it('other entity types keep their behaviour', async () => {
    const res = await post({ entityType: 'note', entityId: 'n1', signal: 'up', comment: 'nice' });
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ comment: 'nice' });
    expect(inserted[0].reason).toBeUndefined();
  });

  it('requires a session', async () => {
    currentUser = null;
    expect((await post({ entityType: 'conversation_message', entityId: MSG, signal: 'up' })).status).toBe(401);
  });
});

// Invariant: feedback on workspace content is only accepted from someone who
// can access that workspace, and it is recorded under that workspace's team.
describe('POST /api/feedback: rated entity must be in a workspace the rater can access', () => {
  it('records feedback under the rated workspace team, not the rater\'s first team', async () => {
    const res = await post({ entityType: 'artifact', entityId: 'a-1', signal: 'down', comment: 'meh' });
    expect(res.status).toBe(201);
    expect(resolvedRefs).toEqual([{ entityType: 'artifact', entityId: 'a-1' }]);
    expect(inserted[0]).toMatchObject({ teamId: 'team-mine', entityType: 'artifact', entityId: 'a-1' });
  });

  it('refuses an entity in a workspace the rater cannot access, and writes nothing', async () => {
    entityWorkspace = 'ws-theirs';
    const res = await post({ entityType: 'note', entityId: 'n-1', signal: 'down', comment: 'x' });
    expect(res.status).toBe(404);
    expect(inserted).toEqual([]);
    expect(updated).toEqual([]);
  });

  it('refuses an entity that resolves to no workspace, with the same reply', async () => {
    entityWorkspace = 'ws-theirs';
    const foreign = await post({ entityType: 'summary', entityId: 'task-x-summary', signal: 'down' });
    entityWorkspace = null;
    const missing = await post({ entityType: 'summary', entityId: 'task-x-summary', signal: 'down' });
    expect(missing.status).toBe(foreign.status);
    expect(await missing.json()).toEqual(await foreign.json());
    expect(inserted).toEqual([]);
  });

  it('does not let a toggle on an inaccessible entity reach the existing row', async () => {
    existing = { id: 'fb-1', signal: 'down', reason: null };
    entityWorkspace = 'ws-theirs';
    const res = await post({ entityType: 'heartbeat', entityId: 't-1', signal: 'down' });
    expect(res.status).toBe(404);
    expect(deleted).toBe(0);
  });
});

describe('GET /api/feedback — conversation_message', () => {
  it('returns signals and reasons', async () => {
    existing = { entityId: MSG, signal: 'down', reason: 'too_slow' };
    const res = await GET(new NextRequest(`http://localhost/api/feedback?entityType=conversation_message&entityIds=${MSG}`));
    expect(await res.json()).toEqual({ feedback: { [MSG]: 'down' }, reasons: { [MSG]: 'too_slow' } });
  });
});
