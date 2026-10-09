/**
 * A personal credential (the requester's own key, delivered on a claim marked
 * `credentialDecision.scope: 'personal'`) reaches exactly one worker: the one
 * for the task it was delivered with. The runner's per-team credential cache
 * (credential-cache.ts) must never hold it, and a personal (or withheld) worker
 * must never pick up the team's cached credential either.
 *
 * Drives the real WorkerManager.startFromClaim with a real CredentialCache:
 * two consecutive tasks of the same team, in both orders.
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('../../src/git-operations', () => ({
  setupWorktree: mock(async () => ({ path: '/tmp/example-worktree', branch: 'buildd/example', base: 'origin/dev' })),
  removeWorktreeIfUnowned: mock(async () => ({ removed: true })),
  removeWorktreeIfUnownedSync: mock(() => ({ removed: true })),
  cleanupWorktree: mock(async () => ({ removed: true })),
  collectGitStats: async () => ({}),
}));
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {}, loadAllWorkers: () => [], loadTerminalWorkersCached: () => [], __resetDiskWorkersCache: () => {}, loadWorker: () => null, deleteWorker: () => {},
}));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({}), checkMcpPreFlight: () => ({ warnings: [] }),
  parseMcpJson: () => [], scanMcpServersRich: () => [],
  checkBwrapSupport: () => true, checkBwrapMountIsolationSupport: () => true,
}));
const { WorkerManager } = await import('../../src/workers');
const { CredentialCache } = await import('../../src/credential-cache');

const TEAM = 'team-shared';
const PERSONAL_KEY = 'sk-ant-personal-requester-key';
const TEAM_KEY = 'sk-ant-team-key';
const TEAM_OAUTH = 'team-oauth-token';

const personalMarker = (surface: 'agent-claude' | 'agent-codex' = 'agent-claude') => ({
  surface, policy: 'personal_only', scope: 'personal', provider: surface === 'agent-codex' ? 'openai' : 'anthropic', runnerLocalAllowed: false,
});

function harness() {
  const manager = Object.create(WorkerManager.prototype) as any;
  Object.assign(manager, {
    workers: new Map(), workerTeamKeys: new Map(), credCache: new CredentialCache(),
    config: {}, buildd: { updateWorker: mock(async () => ({})) },
    sendHeartbeat: () => {}, emit: () => {}, addMilestone: () => {},
    pusherManager: { subscribeToWorker: () => {} },
    startSession: mock(async () => {}),
  });
  let n = 0;
  const start = async (claim: Record<string, unknown>, backend: 'claude' | 'codex' = 'claude') => {
    n++;
    const id = `worker-${n}`;
    await manager.startFromClaim(
      { id, branch: `buildd/task-${n}`, ...claim },
      { id: `task-${n}`, title: `Task ${n}`, backend, workspaceId: 'workspace-a', workspace: { name: 'Example', teamId: TEAM, repo: 'https://github.com/example/repo', gitConfig: { defaultBranch: 'dev' } } },
      '/tmp/example-repo',
    );
    await new Promise(r => setTimeout(r, 0));
    return manager.workers.get(id);
  };
  return { manager, start };
}

describe('personal credential reaches exactly one worker', () => {
  test('personal then team-only: the second task never gets the first task\'s personal key', async () => {
    const { manager, start } = harness();
    const first = await start({ serverApiKey: PERSONAL_KEY, credentialDecision: personalMarker() });
    expect(first.serverApiKey).toBe(PERSONAL_KEY);
    expect(manager.credCache.get(TEAM)).toBeUndefined();

    const second = await start({});
    expect(second.serverApiKey).toBeUndefined();
    expect(second.serverOauthToken).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain(PERSONAL_KEY);
  });

  test('personal then team-only keeps an earlier team credential cached, not overwritten', async () => {
    const { manager, start } = harness();
    await start({ serverApiKey: TEAM_KEY });
    await start({ serverApiKey: PERSONAL_KEY, credentialDecision: personalMarker() });
    const third = await start({});
    expect(third.serverApiKey).toBe(TEAM_KEY);
    expect(manager.credCache.get(TEAM)?.apiKey).toBe(TEAM_KEY);
  });

  test('team-only then personal: the personal worker gets only the requester\'s key', async () => {
    const { start } = harness();
    await start({ serverOauthToken: TEAM_OAUTH });
    const personal = await start({ serverApiKey: PERSONAL_KEY, credentialDecision: personalMarker() });
    expect(personal.serverApiKey).toBe(PERSONAL_KEY);
    expect(personal.serverOauthToken).toBeUndefined();
  });

  test('team-only then personal Codex: the team\'s cached Claude credential is not attached', async () => {
    const { start } = harness();
    await start({ serverOauthToken: TEAM_OAUTH, serverApiKey: TEAM_KEY });
    const personal = await start({
      codexCredential: { credentialType: 'api_key', apiKey: 'sk-openai-personal', expiresAt: null },
      credentialDecision: personalMarker('agent-codex'),
    }, 'codex');
    expect(personal.serverApiKey).toBeUndefined();
    expect(personal.serverOauthToken).toBeUndefined();
    expect(personal.codexCredential.apiKey).toBe('sk-openai-personal');
  });

  test('a withheld claim (scope none) gets no cached team credential', async () => {
    const { start } = harness();
    await start({ serverApiKey: TEAM_KEY });
    const withheld = await start({ credentialDecision: { surface: 'agent-claude', policy: 'personal_only', scope: 'none', runnerLocalAllowed: true } });
    expect(withheld.serverApiKey).toBeUndefined();
    expect(withheld.serverOauthToken).toBeUndefined();
  });

  test('a team-scope marker keeps today\'s cache behaviour', async () => {
    const { start } = harness();
    await start({ serverApiKey: TEAM_KEY, credentialDecision: { surface: 'agent-claude', policy: 'team', scope: 'team', runnerLocalAllowed: true } });
    const next = await start({});
    expect(next.serverApiKey).toBe(TEAM_KEY);
  });

  test('an auth failure on a personal worker does not drop the team\'s cached credential', async () => {
    const { manager, start } = harness();
    Object.assign(manager, { workerAuthContexts: new Map(), consecutiveAuthFailures: 0, contextBreaker: { trip: () => {}, snapshot: () => ({}) }, scheduleResumeAt: () => {} });
    await start({ serverApiKey: TEAM_KEY });
    const personal = await start({ serverApiKey: PERSONAL_KEY, credentialDecision: personalMarker() });
    try { manager.handleAuthFailure(personal.id); } catch { /* unrelated breaker wiring */ }
    expect(manager.credCache.get(TEAM)?.apiKey).toBe(TEAM_KEY);
  });

  test('the worker records the decision (no secret) so the session can honour runnerLocalAllowed', async () => {
    const { start } = harness();
    const w = await start({ serverApiKey: PERSONAL_KEY, credentialDecision: personalMarker() });
    expect(w.credentialDecision).toEqual(personalMarker());
  });
});
