import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockArtifactsFindFirst = mock(() => null as any);
const mockVerifyAccountWorkspaceAccess = mock(() => false as any);
const mockGetCurrentUser = mock(async () => null as any);
const mockVerifyWorkspaceAccess = mock(async () => null as any);
const mockTasksFindFirst = mock(async () => null as any);

// What the PATCH UPDATE ... RETURNING hands back; per-test overridable.
let updatedRow: Record<string, unknown> = { id: 'artifact-1', shareToken: 'test-token' };
// What the PATCH handed to UPDATE ... SET.
let lastSet: Record<string, unknown> | null = null;
const mockTriggerEvent = mock(async (..._args: unknown[]) => {});

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { mission: (id: string) => `mission-${id}`, workspace: (id: string) => `workspace-${id}` },
  events: {},
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// The opt-in GitHub repo check (lib/member-repo-access.ts has its own tests).
const mockAssertMemberRepoAccess = mock(async (..._args: unknown[]) => null as any);
mock.module('@/lib/member-repo-access', () => ({
  assertMemberRepoAccess: mockAssertMemberRepoAccess,
  memberRepoAccessSubject: (a: { sessionUserId?: string } | null, u: { id: string } | null) => (a ? a.sessionUserId ?? null : u?.id ?? null),
}));

let storageConfigured = true;
mock.module('@/lib/storage', () => ({
  isStorageConfigured: () => storageConfigured,
  generateDownloadUrl: async (key: string) => `https://signed.example/${key}`,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: { findFirst: mockArtifactsFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
    update: () => ({
      set: mock((fields: Record<string, unknown>) => (lastSet = fields, {
        where: mock(() => ({
          returning: mock(() => [updatedRow]),
        })),
      })),
    }),
  },
}));

// drizzle-orm and the schema stay real: the PATCH hands UPDATE ... SET an SQL
// merge expression, and it is asserted rendered (PgDialect), not guessed.
import { PgDialect } from 'drizzle-orm/pg-core';
import { artifactMetadataMergeSql } from '@/lib/artifact-metadata-merge';
import { GET, PATCH } from './route';

const dialect = new PgDialect();
const rendered = (v: unknown) => {
  const q = dialect.sqlToQuery(v as any);
  return { sql: q.sql, params: q.params };
};

function createMockGetRequest(apiKey?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest('http://localhost:3000/api/artifacts/artifact-1', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

function createMockPatchRequest(body: object, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest('http://localhost:3000/api/artifacts/artifact-1', {
    method: 'PATCH',
    headers: new Headers(headers),
    body: JSON.stringify(body),
  });
}

const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111';
const mockParams = Promise.resolve({ artifactId: ARTIFACT_ID });
const nonUuidParams = Promise.resolve({ artifactId: 'artifact-1' });

describe('GET /api/artifacts/[artifactId]', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockGetRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when artifact not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue(null);

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Artifact not found');
  });

  it('rejects a non-UUID artifact id (e.g. a short 8-hex id) without querying the db', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: nonUuidParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockArtifactsFindFirst).not.toHaveBeenCalled();
  });

  it('returns artifact when requester owns the worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      type: 'content',
      title: 'Test Artifact',
      content: 'Full content here',
      shareToken: 'share-abc',
      visibility: 'public',
      metadata: { key: 'value' },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      worker: { accountId: 'account-1' },
    });

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact.id).toBe('artifact-1');
    expect(data.artifact.title).toBe('Test Artifact');
    expect(data.artifact.content).toBe('Full content here');
    expect(data.artifact.type).toBe('content');
    expect(data.artifact.shareUrl).toContain('/share/share-abc');
  });

  it('returns artifact when requester has workspace access', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-2' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      type: 'report',
      title: 'Shared Report',
      content: 'Report content',
      shareToken: null,
      metadata: {},
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      worker: { accountId: 'account-1' },
    });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact.title).toBe('Shared Report');
    expect(data.artifact.shareUrl).toBeNull();
  });

  it('omits shareUrl when the artifact is private but still holds a token', async () => {
    // A token only addresses a live share while visibility is 'public'.
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      type: 'content',
      title: 'Unshared',
      content: 'Body',
      shareToken: 'leftover-token',
      visibility: 'private',
      metadata: {},
      worker: { accountId: 'account-1' },
    });

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact.shareUrl).toBeNull();
  });

  it('returns 403 when requester has no access', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-2' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      type: 'content',
      title: 'Private Artifact',
      content: 'Secret',
      shareToken: null,
      metadata: {},
      worker: { accountId: 'account-1' },
    });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
  });

  it('returns 403 when artifact has no workspace and requester is not owner', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-2' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: null,
      type: 'content',
      title: 'Orphan Artifact',
      content: 'Content',
      shareToken: null,
      metadata: {},
      worker: { accountId: 'account-1' },
    });

    const req = createMockGetRequest('bld_test');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
  });
});

describe('GET /api/artifacts/[artifactId] — dashboard session', () => {
  const artifactRow = {
    id: 'artifact-1',
    workerId: 'worker-1',
    workspaceId: 'ws-1',
    type: 'report',
    title: 'Session Report',
    content: 'Body',
    shareToken: null,
    visibility: 'private',
    metadata: {},
    worker: { accountId: 'account-1', workspaceId: 'ws-1' },
  };

  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);
  });

  it('returns the artifact to a signed-in member of its workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockArtifactsFindFirst.mockResolvedValue(artifactRow);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });

    const res = await GET(createMockGetRequest(), { params: mockParams });

    expect(res.status).toBe(200);
    expect((await res.json()).artifact.title).toBe('Session Report');
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-1', 'ws-1');
  });

  it('a diff artifact goes through the member repo access check for a session', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockArtifactsFindFirst.mockResolvedValue({ ...artifactRow, type: 'diff' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockAssertMemberRepoAccess.mockResolvedValueOnce(Response.json({ error: 'member_repo_access', reason: 'not_collaborator' }, { status: 403 }));

    const res = await GET(createMockGetRequest(), { params: mockParams });

    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('not_collaborator');
    expect(mockAssertMemberRepoAccess).toHaveBeenLastCalledWith('user-1', 'ws-1');
  });

  it('a non-diff artifact is not repo-access checked', async () => {
    mockAssertMemberRepoAccess.mockClear();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockArtifactsFindFirst.mockResolvedValue(artifactRow);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });

    const res = await GET(createMockGetRequest(), { params: mockParams });

    expect(res.status).toBe(200);
    expect(mockAssertMemberRepoAccess).not.toHaveBeenCalled();
  });

  it('404s (not 403) a signed-in user outside the artifact workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-2' });
    mockArtifactsFindFirst.mockResolvedValue(artifactRow);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const res = await GET(createMockGetRequest(), { params: mockParams });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Artifact not found');
  });

  it('falls back to the worker workspace when the artifact row has none', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockArtifactsFindFirst.mockResolvedValue({ ...artifactRow, workspaceId: null, worker: { accountId: 'a', workspaceId: 'ws-9' } });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });

    const res = await GET(createMockGetRequest(), { params: mockParams });

    expect(res.status).toBe(200);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-1', 'ws-9');
  });

  it('404s a signed-in user when the artifact has no workspace at all', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockArtifactsFindFirst.mockResolvedValue({ ...artifactRow, workspaceId: null, worker: null });

    const res = await GET(createMockGetRequest(), { params: mockParams });

    expect(res.status).toBe(404);
    expect(mockVerifyWorkspaceAccess).not.toHaveBeenCalled();
  });

  it('returns 401 with neither a session nor a key', async () => {
    const res = await GET(createMockGetRequest(), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('keeps the API key path authoritative when a key is present', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-2' });
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockArtifactsFindFirst.mockResolvedValue(artifactRow);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);

    const res = await GET(createMockGetRequest('bld_test'), { params: mockParams });

    expect(res.status).toBe(403);
    expect(mockVerifyWorkspaceAccess).not.toHaveBeenCalled();
  });

  it('does not accept a session on PATCH', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockArtifactsFindFirst.mockResolvedValue(artifactRow);

    const res = await PATCH(createMockPatchRequest({ title: 'x' }), { params: mockParams });

    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/artifacts/[artifactId]', () => {
  beforeEach(() => {
    updatedRow = { id: 'artifact-1', shareToken: 'test-token', visibility: 'public' };
    mockAuthenticateApiKey.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const req = createMockPatchRequest({ title: 'New Title' });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when artifact not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue(null);
    const req = createMockPatchRequest({ title: 'New Title' }, 'bld_test');
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('rejects a non-UUID artifact id without querying the db', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    const req = createMockPatchRequest({ title: 'New Title' }, 'bld_test');
    const res = await PATCH(req, { params: nonUuidParams });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockArtifactsFindFirst).not.toHaveBeenCalled();
  });

  it('allows update when requester owns the worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      type: 'summary',
      title: 'Old Title',
      content: 'Old content',
      shareToken: 'tok',
      metadata: {},
      worker: { accountId: 'account-1' },
    });
    const req = createMockPatchRequest({ title: 'New Title' }, 'bld_test');
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
  });

  it('omits shareUrl in the PATCH response when the artifact is private', async () => {
    updatedRow = { id: 'artifact-1', shareToken: 'leftover-token', visibility: 'private' };
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      shareToken: 'leftover-token',
      visibility: 'private',
      worker: { accountId: 'account-1' },
    });

    const res = await PATCH(createMockPatchRequest({ title: 'New Title' }, 'bld_test'), { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact.shareUrl).toBeNull();
  });

  it('returns a shareUrl in the PATCH response when the artifact is public', async () => {
    updatedRow = { id: 'artifact-1', shareToken: 'live-token', visibility: 'public' };
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      shareToken: 'live-token',
      visibility: 'public',
      worker: { accountId: 'account-1' },
    });

    const res = await PATCH(createMockPatchRequest({ title: 'New Title' }, 'bld_test'), { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact.shareUrl).toContain('/share/live-token');
  });

  it('returns 403 when requester does not own the worker and has no workspace access', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-2' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      type: 'summary',
      title: 'Old Title',
      content: 'Old content',
      shareToken: 'tok',
      metadata: {},
      worker: { accountId: 'account-1' },
    });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    const req = createMockPatchRequest({ title: 'New Title' }, 'bld_test');
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(403);
  });

  it('allows retry worker to update mission-level artifact (workerId null) via workspace membership', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: null,
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      type: 'summary',
      title: 'Closeout',
      content: 'Old summary',
      shareToken: 'tok',
      metadata: {},
      worker: null,
    });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    const req = createMockPatchRequest({ content: 'Corrected summary' }, 'bld_test');
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
  });

  it('returns 403 when mission artifact has no workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      workerId: null,
      workspaceId: null,
      missionId: 'mission-1',
      type: 'summary',
      title: 'Closeout',
      content: 'Old summary',
      shareToken: 'tok',
      metadata: {},
      worker: null,
    });
    const req = createMockPatchRequest({ content: 'Corrected summary' }, 'bld_test');
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(403);
  });

  // docs/design/visual-qa-human-review.md, "PATCH integrity fix": the auditor
  // prompt sends update_artifact {metadata: {qa: {fixTaskId}}}. A wholesale
  // replace erased route/viewport/finding and dropped the shot from the
  // evidence check and the strip.
  describe('metadata merge', () => {
    const shotRow = {
      id: 'artifact-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      type: 'screenshot',
      storageKey: 'qa/ws-1/artifact-1/tasks-mobile.png',
      metadata: {
        qa: { runKey: 'run-1', route: '/app/tasks', viewport: 'mobile', finding: 'Header overflows.', verdict: 'issue' },
        filename: 'tasks-mobile.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
      },
      worker: { accountId: 'account-1' },
    };

    beforeEach(() => {
      lastSet = null;
      mockTriggerEvent.mockClear();
      mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
      mockArtifactsFindFirst.mockResolvedValue(shotRow);
    });

    // The merge semantics (qa deep, top level shallow) are pinned in
    // lib/artifact-metadata-merge.test.ts. Here: the route hands SET that SQL
    // merge of the raw patch, and nothing it read, so an overlapping PATCH of
    // the same shot (a caption edit landing with a fix link) is not lost.
    it('deep-merges metadata.qa in SQL: a qa.fixTaskId update sends only the patch, merged onto the stored column', async () => {
      const patch = { qa: { fixTaskId: 'fix-1' } };
      const res = await PATCH(createMockPatchRequest({ metadata: patch }, 'bld_test'), { params: mockParams });
      expect(res.status).toBe(200);
      const set = rendered(lastSet!.metadata);
      expect(set).toEqual(rendered(artifactMetadataMergeSql(patch)));
      expect(set.sql).toContain('jsonb_set(');
      expect(set.sql).toContain(`"artifacts"."metadata" -> 'qa'`);
      // The stored route, finding and filename are never re-sent from the read.
      expect(JSON.stringify(set.params)).not.toContain('Header overflows.');
      expect(JSON.stringify(set.params)).not.toContain('tasks-mobile.png');
    });

    it('shallow-merges top-level keys in SQL', async () => {
      const patch = { note: 'x', filename: 'renamed.png' };
      await PATCH(createMockPatchRequest({ metadata: patch }, 'bld_test'), { params: mockParams });
      const set = rendered(lastSet!.metadata);
      expect(set).toEqual(rendered(artifactMetadataMergeSql(patch)));
      expect(set.sql).not.toContain('jsonb_set(');
      expect(set.params).toEqual([JSON.stringify(patch)]);
    });

    it('merges onto an artifact with no metadata yet (a non-object column counts as {})', async () => {
      mockArtifactsFindFirst.mockResolvedValue({ ...shotRow, metadata: null });
      await PATCH(createMockPatchRequest({ metadata: { qa: { fixTaskId: 'fix-1' } } }, 'bld_test'), { params: mockParams });
      expect(rendered(lastSet!.metadata).sql).toContain(`jsonb_typeof("artifacts"."metadata") = 'object'`);
    });

    it('leaves metadata alone when the body sends none', async () => {
      await PATCH(createMockPatchRequest({ title: 'x' }, 'bld_test'), { params: mockParams });
      expect(lastSet).not.toHaveProperty('metadata');
    });

    it('rejects metadata that is not an object', async () => {
      const res = await PATCH(createMockPatchRequest({ metadata: ['a'] }, 'bld_test'), { params: mockParams });
      expect(res.status).toBe(400);
      expect(lastSet).toBeNull();
    });

    it('fires worker:artifact on the mission channel for a qa/ audit shot', async () => {
      await PATCH(createMockPatchRequest({ metadata: { qa: { fixTaskId: 'fix-1' } } }, 'bld_test'), { params: mockParams });
      expect(mockTriggerEvent).toHaveBeenCalledWith('mission-mission-1', 'worker:artifact', { artifact: { id: 'artifact-1', workerId: 'worker-1', missionId: 'mission-1' } });
    });

    it('fires nothing for a non-audit artifact', async () => {
      mockArtifactsFindFirst.mockResolvedValue({ ...shotRow, storageKey: 'artifacts/ws-1/artifact-1/report.pdf', type: 'file' });
      await PATCH(createMockPatchRequest({ title: 'x' }, 'bld_test'), { params: mockParams });
      expect(mockTriggerEvent).not.toHaveBeenCalled();
    });
  });
});

describe('/api/artifacts/[artifactId] — per-task token', () => {
  const SCOPED = { id: 'account-1', level: 'worker', scopes: null, taskScope: { taskId: 'task-own', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
  const base = { id: ARTIFACT_ID, type: 'report', title: 'T', content: 'c', shareToken: null, visibility: 'private', metadata: {}, initiativeId: null, storageKey: null };

  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    mockArtifactsFindFirst.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue({ missionId: 'mission-own', workspaceId: 'ws-1', mission: { initiativeId: null } });
    lastSet = null;
    updatedRow = { id: ARTIFACT_ID, shareToken: null };
  });

  it('reads an artifact in its own workspace', async () => {
    mockArtifactsFindFirst.mockResolvedValue({ ...base, workerId: null, workspaceId: 'ws-1', missionId: 'mission-x', worker: null });
    const res = await GET(createMockGetRequest('bld_test'), { params: mockParams });
    expect(res.status).toBe(200);
  });

  it("reads its account's own worker's artifact in another workspace as not found", async () => {
    mockArtifactsFindFirst.mockResolvedValue({ ...base, workerId: 'w-2', workspaceId: 'ws-2', missionId: null, worker: { accountId: 'account-1', taskId: 'task-other', workspaceId: 'ws-2' } });
    const res = await GET(createMockGetRequest('bld_test'), { params: mockParams });
    expect(res.status).toBe(404);
  });

  it("updates its own task's artifact", async () => {
    mockArtifactsFindFirst.mockResolvedValue({ ...base, workerId: 'w-1', workspaceId: 'ws-1', missionId: 'mission-own', worker: { accountId: 'account-1', taskId: 'task-own', workspaceId: 'ws-1' } });
    const res = await PATCH(createMockPatchRequest({ title: 'New' }, 'bld_test'), { params: mockParams });
    expect(res.status).toBe(200);
    expect(lastSet?.title).toBe('New');
  });

  it("updates its own mission's mission-level artifact", async () => {
    mockArtifactsFindFirst.mockResolvedValue({ ...base, workerId: null, workspaceId: 'ws-1', missionId: 'mission-own', worker: null });
    const res = await PATCH(createMockPatchRequest({ content: 'x' }, 'bld_test'), { params: mockParams });
    expect(res.status).toBe(200);
    expect(lastSet?.content).toBe('x');
  });

  it("is refused a sibling task's artifact on its own mission, before writing", async () => {
    mockArtifactsFindFirst.mockResolvedValue({ ...base, workerId: 'w-2', workspaceId: 'ws-1', missionId: 'mission-own', worker: { accountId: 'account-1', taskId: 'task-other', workspaceId: 'ws-1' } });
    const res = await PATCH(createMockPatchRequest({ title: 'New' }, 'bld_test'), { params: mockParams });
    expect(res.status).toBe(403);
    expect(lastSet).toBeNull();
  });

  it("is refused another mission's artifact in its workspace, before writing", async () => {
    mockArtifactsFindFirst.mockResolvedValue({ ...base, workerId: null, workspaceId: 'ws-1', missionId: 'mission-other', worker: null });
    const res = await PATCH(createMockPatchRequest({ title: 'New' }, 'bld_test'), { params: mockParams });
    expect(res.status).toBe(403);
    expect(lastSet).toBeNull();
  });

  it('reads an artifact in another workspace as not found on PATCH, before writing', async () => {
    mockArtifactsFindFirst.mockResolvedValue({ ...base, workerId: null, workspaceId: 'ws-2', missionId: 'mission-own', worker: null });
    const res = await PATCH(createMockPatchRequest({ title: 'New' }, 'bld_test'), { params: mockParams });
    expect(res.status).toBe(404);
    expect(lastSet).toBeNull();
  });

  it('an account key still updates any artifact in a workspace it can reach', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'worker' });
    mockArtifactsFindFirst.mockResolvedValue({ ...base, workerId: null, workspaceId: 'ws-2', missionId: 'mission-other', worker: null });
    const res = await PATCH(createMockPatchRequest({ title: 'New' }, 'bld_test'), { params: mockParams });
    expect(res.status).toBe(200);
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
  });
});

describe('GET /api/artifacts/[artifactId] — file artifact download URL', () => {
  const fileRow = {
    id: 'artifact-1', workerId: 'worker-1', workspaceId: 'ws-1', type: 'file', title: 'proto',
    content: null, shareToken: null, visibility: 'private', metadata: {}, storageKey: 'ws-1/proto.html',
    worker: { accountId: 'account-1', workspaceId: 'ws-1' },
  };

  beforeEach(() => {
    storageConfigured = true;
    mockAuthenticateApiKey.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
  });

  it('includes a presigned downloadUrl for a file artifact the caller may read', async () => {
    mockArtifactsFindFirst.mockResolvedValue(fileRow);
    const res = await GET(createMockGetRequest('bld_test'), { params: mockParams });
    expect((await res.json()).artifact.downloadUrl).toBe('https://signed.example/ws-1/proto.html');
  });

  it('omits downloadUrl when storage is not configured', async () => {
    storageConfigured = false;
    mockArtifactsFindFirst.mockResolvedValue(fileRow);
    const res = await GET(createMockGetRequest('bld_test'), { params: mockParams });
    expect((await res.json()).artifact.downloadUrl).toBeNull();
  });

  it('omits downloadUrl for an artifact without a stored file', async () => {
    mockArtifactsFindFirst.mockResolvedValue({ ...fileRow, storageKey: null });
    const res = await GET(createMockGetRequest('bld_test'), { params: mockParams });
    expect((await res.json()).artifact.downloadUrl).toBeNull();
  });
});
