/**
 * `ensureMissionIntegrationBranch` — the IO half of Option A′.
 *
 * The interesting behaviour is all in how it reads GitHub's 4xx bodies. Ref
 * creation returns 422 for the case we WANT ("Reference already exists", a
 * concurrent caller won the race) and 422 for several cases that mean the
 * branch does not exist and never will on this input — a bad or GC'd sha, an
 * invalid ref name, a generic validation failure. Reporting success for those
 * is the worst available outcome: the caller posts no note, nothing points at
 * the branch, and every task PR for the mission then fails to open against a
 * base ref that is absent.
 *
 * So each test here drives a real GitHub error body through the same string
 * shape `githubApi` throws (`GitHub API error: <status> <body>`).
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockMissionsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockGithubReposFindFirst = mock(() => null as any);
const mockGithubApi = mock(() => Promise.resolve(null as any));
const mockTasksFindMany = mock(() => Promise.resolve([] as any[]));
const gateEvents: any[] = [];

const noteInserts: any[] = [];
let noteInsertThrows = false;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
      tasks: { findMany: mockTasksFindMany },
    },
    insert: (table: any) => ({
      values: (v: any) => {
        if (noteInsertThrows) return Promise.reject(new Error('mission_notes unavailable'));
        noteInserts.push({ table, values: v });
        return Promise.resolve();
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id' },
  missionNotes: { __name: 'missionNotes' },
  workspaces: { id: 'id' },
  githubRepos: { id: 'id' },
  tasks: { missionId: 'missionId' },
  workerErrorTraces: { __name: 'workerErrorTraces' },
}));

mock.module('@buildd/core/gate-events', () => ({
  GATE_SLUGS: { MISSION_BRANCH_UNRESOLVED: 'mission_branch_unresolved' },
  recordGateEvent: (input: any) => {
    gateEvents.push(input);
    return Promise.resolve();
  },
}));

mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

import {
  ensureIntegrationBaseForTaskPr,
  ensureMissionIntegrationBranch,
  resolveMissionRepoWorkspaceId,
} from './mission-integration-branch';
import { gateFrictionSignature } from '@buildd/core/gate-friction-signature';

/** Mission notes only — error-trace rows go to their own table. */
const notesOnly = () => noteInserts.filter(n => n.table?.__name === 'missionNotes');
const tracesOnly = () => noteInserts.filter(n => n.table?.__name === 'workerErrorTraces');

const BRANCH = 'mission/example-slug-0a1b2c3d';
const REPO_FULL_NAME = 'example-org/example-repo';

/** The exact string shape `githubApi` throws on a non-2xx response. */
function githubError(status: number, body: unknown): Error {
  return new Error(
    `GitHub API error: ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`,
  );
}

function withOptedInMission() {
  mockMissionsFindFirst.mockResolvedValue({
    workingBranch: BRANCH,
    integrationBranchEnabled: true,
    workspaceId: 'ws-1',
  });
  mockWorkspacesFindFirst.mockResolvedValue({
    githubRepoId: 'repo-1',
    githubInstallationId: 'inst-row-1',
    gitConfig: { targetBranch: 'trunk-branch' },
  });
  mockGithubReposFindFirst.mockResolvedValue({
    fullName: REPO_FULL_NAME,
    defaultBranch: 'trunk-branch',
    installation: { installationId: 4242 },
  });
}

/**
 * Wire the two GitHub calls the create path makes: the existence probe (404 —
 * not there yet) and the trunk head lookup (a sha), then let the caller decide
 * how `POST /git/refs` fails.
 */
function createPathWith(postOutcome: { throws?: Error; resolves?: unknown }) {
  mockGithubApi.mockImplementation(((_installationId: number, path: string, options?: RequestInit) => {
    if (path.endsWith(`/git/ref/heads/${BRANCH}`)) {
      return Promise.reject(githubError(404, { message: 'Not Found' }));
    }
    if (path.endsWith('/git/ref/heads/trunk-branch')) {
      return Promise.resolve({ object: { sha: 'a'.repeat(40) } });
    }
    if (path.endsWith('/git/refs') && options?.method === 'POST') {
      return postOutcome.throws
        ? Promise.reject(postOutcome.throws)
        : Promise.resolve(postOutcome.resolves ?? {});
    }
    return Promise.resolve(null);
  }) as any);
}

describe('ensureMissionIntegrationBranch', () => {
  beforeEach(() => {
    mockMissionsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockGithubApi.mockReset();
  });

  it('creates the branch when it is absent', async () => {
    withOptedInMission();
    createPathWith({ resolves: { ref: `refs/heads/${BRANCH}` } });

    expect(await ensureMissionIntegrationBranch('m-1')).toEqual({
      ok: true,
      branch: BRANCH,
      created: true,
    });
  });

  it('treats a 422 that says the reference already exists as success', async () => {
    // The race we designed for: a concurrent caller created the ref between our
    // probe and our POST. The post-condition holds, so this is not an error.
    withOptedInMission();
    createPathWith({
      throws: githubError(422, {
        message: 'Reference already exists',
        documentation_url: 'https://docs.github.com/rest/git/refs#create-a-reference',
      }),
    });

    expect(await ensureMissionIntegrationBranch('m-1')).toEqual({
      ok: true,
      branch: BRANCH,
      created: false,
    });
  });

  it('matches the already-exists message case-insensitively', async () => {
    withOptedInMission();
    createPathWith({ throws: githubError(422, { message: 'reference already EXISTS' }) });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(true);
  });

  it('reports api_error for a 422 whose sha does not exist', async () => {
    // A GC'd or mistyped sha. The branch was NOT created, so calling this a
    // success is how a mission ends up with every task PR failing to open and
    // nothing in the feed pointing at the branch.
    withOptedInMission();
    createPathWith({
      throws: githubError(422, {
        message: 'Object does not exist',
        errors: [{ resource: 'Reference', code: 'custom', field: 'sha', message: 'Object does not exist' }],
      }),
    });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('api_error');
    expect(result.detail).toContain('Object does not exist');
  });

  it('reports api_error for a 422 that rejects the ref name', async () => {
    withOptedInMission();
    createPathWith({
      throws: githubError(422, { message: 'Reference cannot be updated' }),
    });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('api_error');
  });

  it('reports api_error for a generic 422 validation failure', async () => {
    withOptedInMission();
    createPathWith({
      throws: githubError(422, { message: 'Validation Failed', errors: [{ resource: 'Reference' }] }),
    });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('api_error');
  });

  it('reports empty_repo for the 409 an unborn repository returns', async () => {
    // Ref creation can never succeed here, and the fix is not "retry" — it is
    // "push a first commit". Its own reason so the caller can say that.
    withOptedInMission();
    createPathWith({ throws: githubError(409, { message: 'Git Repository is empty.' }) });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('empty_repo');
  });

  it('reports empty_repo when the existence probe itself hits an empty repository', async () => {
    withOptedInMission();
    mockGithubApi.mockImplementation((() =>
      Promise.reject(githubError(409, { message: 'Git Repository is empty.' }))) as any);

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('empty_repo');
  });

  it('reports the branch as already present without creating anything', async () => {
    withOptedInMission();
    mockGithubApi.mockImplementation((() => Promise.resolve({ object: { sha: 'b'.repeat(40) } })) as any);

    expect(await ensureMissionIntegrationBranch('m-1')).toEqual({
      ok: true,
      branch: BRANCH,
      created: false,
    });
    // Probe only — no trunk lookup, no POST.
    expect(mockGithubApi).toHaveBeenCalledTimes(1);
  });

  it('reports not_opted_in without touching GitHub', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      workingBranch: BRANCH,
      integrationBranchEnabled: false,
      workspaceId: 'ws-1',
    });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not_opted_in');
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('reports no_working_branch when the mission has no branch name yet', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      workingBranch: null,
      integrationBranchEnabled: true,
      workspaceId: 'ws-1',
    });

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('no_working_branch');
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('reports api_error when trunk has no resolvable head', async () => {
    withOptedInMission();
    mockGithubApi.mockImplementation(((_installationId: number, path: string) => {
      if (path.endsWith(`/git/ref/heads/${BRANCH}`)) {
        return Promise.reject(githubError(404, { message: 'Not Found' }));
      }
      return Promise.resolve({ object: {} });
    }) as any);

    const result = await ensureMissionIntegrationBranch('m-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('api_error');
  });
});


// ── Part 2: the route out when the integration branch is already gone ───────
//
// A merging mission PR deletes the integration branch by design. A task of that
// mission claimed afterwards derives a base that does not exist, and both doors
// shut: create_pr refuses trunk (the mission HAS an integration base) and
// GitHub refuses the derived base (it is not there). The worker cannot deliver
// at all, and there is no owner in the loop to fix it.
//
// The decision here is to RE-CUT the branch from trunk and proceed, so the
// mission keeps its one-merge-per-round shape via a second mission PR. Trunk
// fallback survives only for when the branch can neither be found nor created.
// Either way the choice is recorded as a mission note, never silent.

describe('ensureIntegrationBaseForTaskPr', () => {
  beforeEach(() => {
    mockMissionsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockGithubApi.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
    noteInserts.length = 0;
    gateEvents.length = 0;
    noteInsertThrows = false;
  });

  it('is a silent pass-through when the branch is still there', async () => {
    withOptedInMission();
    mockGithubApi.mockResolvedValue({ object: { sha: 'b'.repeat(40) } });

    expect(await ensureIntegrationBaseForTaskPr({
      missionId: 'm-1',
      integrationBase: BRANCH,
      taskTitle: 'Late slice',
    })).toEqual({ usable: true, recreated: false });
    // No note: nothing happened worth announcing on the common path.
    expect(noteInserts).toEqual([]);
    expect(gateEvents).toEqual([]);
  });

  it('re-cuts the deleted branch from trunk and records the decision', async () => {
    withOptedInMission();
    createPathWith({ resolves: { ref: `refs/heads/${BRANCH}` } });

    const got = await ensureIntegrationBaseForTaskPr({
      missionId: 'm-1',
      integrationBase: BRANCH,
      taskTitle: 'Late slice',
    });

    expect(got).toEqual({ usable: true, recreated: true });
    // The ref was actually created, from trunk.
    expect(mockGithubApi).toHaveBeenCalledWith(
      4242,
      `/repos/${REPO_FULL_NAME}/git/refs`,
      expect.objectContaining({ method: 'POST' }),
    );
    // And the choice is on the mission feed, naming the branch and the task.
    expect(notesOnly()).toHaveLength(1);
    expect(notesOnly()[0].values.missionId).toBe('m-1');
    expect(notesOnly()[0].values.title).toContain(BRANCH);
    expect(notesOnly()[0].values.body).toContain('Late slice');
    expect(notesOnly()[0].values.body).toContain('SECOND mission PR');
  });

  it('falls back to trunk — loudly — when the branch cannot be re-cut either', async () => {
    // Last resort. A worker that cannot deliver its PR at all is strictly worse
    // than one that delivers to trunk with the breach written down.
    withOptedInMission();
    createPathWith({ throws: githubError(422, { message: 'Invalid request.' }) });

    const got = await ensureIntegrationBaseForTaskPr({
      missionId: 'm-1',
      integrationBase: BRANCH,
      taskTitle: 'Late slice',
      fallbackBase: 'trunk-branch',
    });

    expect(got.usable).toBe(false);
    expect(notesOnly()).toHaveLength(1);
    expect(notesOnly()[0].values.title).toContain('trunk-branch');
    expect(notesOnly()[0].values.body).toContain('does NOT hold');
  });

  it('does not fail the PR when the note cannot be written', async () => {
    // Best-effort bookkeeping must never be the reason a task cannot deliver.
    withOptedInMission();
    createPathWith({ resolves: { ref: `refs/heads/${BRANCH}` } });
    noteInsertThrows = true;

    expect(await ensureIntegrationBaseForTaskPr({
      missionId: 'm-1',
      integrationBase: BRANCH,
    })).toEqual({ usable: true, recreated: true });
  });
});

// ── Regression: a mission created WITHOUT a workspace ────────────────────────
//
// Mission 6341fe61: created with no workspace, so `resolveBranchStrategy(null)`
// defaulted it to mission-branch and a branch name was generated — but
// `ensureMissionIntegrationBranch` looked only at `missions.workspaceId`, found
// nothing, and answered `no_repo` on every call. The branch was never created,
// every task worktree was cut from trunk, and every task PR (merged via its own
// `buildd/*` branch) silently fell back to trunk.

function withWorkspacelessMission() {
  mockMissionsFindFirst.mockResolvedValue({
    workingBranch: BRANCH,
    integrationBranchEnabled: true,
    workspaceId: null,
  });
  mockWorkspacesFindFirst.mockResolvedValue({
    githubRepoId: 'repo-1',
    githubInstallationId: 'inst-row-1',
    gitConfig: { targetBranch: 'trunk-branch' },
  });
  mockGithubReposFindFirst.mockResolvedValue({
    fullName: REPO_FULL_NAME,
    defaultBranch: 'trunk-branch',
    installation: { installationId: 4242 },
  });
}

describe('a mission with no workspace whose tasks live in a repo-linked one', () => {
  beforeEach(() => {
    mockMissionsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockGithubApi.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
    noteInserts.length = 0;
    gateEvents.length = 0;
    noteInsertThrows = false;
  });

  it('recovers: create_pr cuts the absent branch from trunk in the TASK workspace repo', async () => {
    withWorkspacelessMission();
    createPathWith({ resolves: { ref: `refs/heads/${BRANCH}` } });

    const got = await ensureIntegrationBaseForTaskPr({
      missionId: 'm-1',
      integrationBase: BRANCH,
      taskTitle: 'docs slice',
      fallbackBase: 'trunk-branch',
      workspaceId: 'ws-task',
      taskId: 't-1',
      workerId: 'w-1',
    });

    expect(got).toEqual({ usable: true, recreated: true });
    // The repo was looked up through the task's workspace, not the mission's (null).
    expect((mockWorkspacesFindFirst.mock.calls[0] as any[])[0].where.value).toBe('ws-task');
    expect(mockGithubApi).toHaveBeenCalledWith(
      4242,
      `/repos/${REPO_FULL_NAME}/git/refs`,
      expect.objectContaining({ method: 'POST' }),
    );
    // Traced, even though it recovered: `recut_from_trunk` is the fallback taken.
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({
      gate: 'mission_branch_unresolved',
      outcome: 'warned',
      missionId: 'm-1',
      workerId: 'w-1',
      detail: expect.objectContaining({ branch: BRANCH, where: 'create_pr', cause: 'missing', fallback: 'recut_from_trunk' }),
    });
    expect(tracesOnly()).toHaveLength(1);
    expect(tracesOnly()[0].values).toMatchObject({ workerId: 'w-1', taskId: 't-1', pattern: 'mission_branch_unresolved' });
    expect(tracesOnly()[0].values.excerpt).toContain(BRANCH);
  });

  it('falls back to the one workspace the mission tasks share when no caller workspace is given', async () => {
    mockTasksFindMany.mockResolvedValue([{ workspaceId: 'ws-task' }, { workspaceId: 'ws-task' }]);
    expect(await resolveMissionRepoWorkspaceId({ missionId: 'm-1', missionWorkspaceId: null }))
      .toEqual({ workspaceId: 'ws-task' });
  });

  it('refuses to guess when the tasks span several workspaces', async () => {
    mockTasksFindMany.mockResolvedValue([{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }]);
    const got = await resolveMissionRepoWorkspaceId({ missionId: 'm-1', missionWorkspaceId: null });
    expect(got.workspaceId).toBeNull();
    expect(got.detail).toContain('2 workspaces');
  });

  it('when recovery is impossible: PR falls back to trunk with an actionable note naming the mission and branch, and a stranded trace', async () => {
    withWorkspacelessMission();
    // Nothing anywhere names a workspace: no caller hint, no task workspace.
    mockTasksFindMany.mockResolvedValue([]);

    const got = await ensureIntegrationBaseForTaskPr({
      missionId: '6341fe61-mission-a',
      integrationBase: BRANCH,
      taskTitle: 'docs slice',
      fallbackBase: 'trunk-branch',
      workerId: 'w-1',
      taskId: 't-1',
    });

    expect(got.usable).toBe(false);
    expect(mockGithubApi).not.toHaveBeenCalled();
    const note = notesOnly()[0].values;
    expect(note.title).toContain(BRANCH);
    expect(note.body).toContain('6341fe61');
    expect(note.body).toContain('no_repo');
    expect(note.body).toContain('**To fix:**');
    expect(note.body).toContain('workspaceId');
    expect(gateEvents[0]).toMatchObject({
      gate: 'mission_branch_unresolved',
      outcome: 'stranded',
      detail: expect.objectContaining({ cause: 'no_repo', fallback: 'trunk_pr_base', where: 'create_pr' }),
    });
  });

  it('groups repeats: two missions/branches hitting the same failure share one signature', async () => {
    withWorkspacelessMission();
    mockTasksFindMany.mockResolvedValue([]);
    await ensureIntegrationBaseForTaskPr({ missionId: 'm-1', integrationBase: BRANCH, workerId: 'w-1' });
    mockMissionsFindFirst.mockResolvedValue({
      workingBranch: 'mission/another-mission-9f8e7d6c',
      integrationBranchEnabled: true,
      workspaceId: null,
    });
    await ensureIntegrationBaseForTaskPr({
      missionId: 'm-2', integrationBase: 'mission/another-mission-9f8e7d6c', workerId: 'w-2',
    });

    expect(gateEvents).toHaveLength(2);
    // Same gate reason → same friction signature, i.e. one rollup row, not two singletons.
    expect(gateEvents[0].reason).toBe(gateEvents[1].reason);
    expect(gateFrictionSignature(gateEvents[0].gate, gateEvents[0].reason))
      .toBe(gateFrictionSignature(gateEvents[1].gate, gateEvents[1].reason));
    // And the error-trace pattern (what get_error_traces GROUPs BY) is the same.
    expect(tracesOnly().map(t => t.values.pattern)).toEqual(['mission_branch_unresolved', 'mission_branch_unresolved']);
    // The variable parts live in detail, not in the identity.
    expect(gateEvents[0].detail.branch).not.toBe(gateEvents[1].detail.branch);
  });
});
