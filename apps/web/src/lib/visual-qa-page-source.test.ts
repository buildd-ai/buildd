import { describe, it, expect } from 'bun:test';
import { resolvePageSource, type GitHubGet } from './visual-qa-page-source';

const REPO = 'acme/web';
const SHA = 'b'.repeat(40);
const URL_ = 'https://web-git-feature-acme.vercel.app';
const T0 = Date.parse('2026-01-01T00:00:00Z');

function github(routes: Record<string, unknown>): GitHubGet & { calls: string[] } {
  const calls: string[] = [];
  const get = (async (path: string) => {
    calls.push(path);
    const key = Object.keys(routes).find(k => path.startsWith(k));
    if (!key) throw new Error('GitHub API error: 404 Not Found');
    const v = routes[key];
    if (v instanceof Error) throw v;
    return v;
  }) as GitHubGet & { calls: string[] };
  get.calls = calls;
  return get;
}

const ready = {
  [`/repos/${REPO}/commits/`]: { sha: SHA },
  [`/repos/${REPO}/deployments?sha=${SHA}`]: [{ id: 7, environment: 'Preview', sha: SHA, created_at: new Date(T0).toISOString() }],
  [`/repos/${REPO}/deployments/7/statuses`]: [{ state: 'success', environment_url: URL_, created_at: new Date(T0).toISOString() }],
};

describe('resolvePageSource', () => {
  it('sandbox (the default) makes no GitHub call', async () => {
    const get = github(ready);
    const r = await resolvePageSource({ get, repoFullName: REPO, gitConfig: {} });
    expect(r.decision).toMatchObject({ ok: true, source: 'sandbox' });
    expect(get.calls).toHaveLength(0);
  });

  it('auto with a READY preview on the trunk head returns its URL', async () => {
    const r = await resolvePageSource({ get: github(ready), repoFullName: REPO, gitConfig: { visualQa: { pageSource: 'auto' }, defaultBranch: 'main' } });
    expect(r.sha).toBe(SHA);
    expect(r.decision).toMatchObject({ ok: true, source: 'vercel-preview', baseUrl: URL_ });
  });

  it('resolves a PR number to its head commit', async () => {
    const get = github({ ...ready, [`/repos/${REPO}/pulls/12`]: { head: { sha: SHA } } });
    const r = await resolvePageSource({ get, repoFullName: REPO, gitConfig: { visualQa: { pageSource: 'vercel-preview' } }, prNumber: 12 });
    expect(r.decision).toMatchObject({ ok: true, baseUrl: URL_ });
    expect(get.calls[0]).toBe(`/repos/${REPO}/pulls/12`);
  });

  it('vercel-preview without a GitHub installation is loud, not a fallback', async () => {
    const r = await resolvePageSource({ get: null, repoFullName: null, gitConfig: { visualQa: { pageSource: 'vercel-preview' } } });
    expect(r.decision).toMatchObject({ ok: false, error: 'preview_unavailable' });
  });

  it('a 403 on deployments names the missing App permission', async () => {
    const get = github({ ...ready, [`/repos/${REPO}/deployments?sha=${SHA}`]: new Error('GitHub API error: 403 Resource not accessible by integration') });
    const r = await resolvePageSource({ get, repoFullName: REPO, gitConfig: { visualQa: { pageSource: 'vercel-preview' } }, sha: SHA });
    expect(r.preview).toMatchObject({ state: 'unreadable' });
    if (r.preview?.state === 'unreadable') expect(r.preview.reason).toMatch(/Deployments: read/);
  });

  it('auto falls back to sandbox when the commit has no preview', async () => {
    const get = github({ ...ready, [`/repos/${REPO}/deployments?sha=${SHA}`]: [] });
    const r = await resolvePageSource({ get, repoFullName: REPO, gitConfig: { visualQa: { pageSource: 'auto' } }, sha: SHA });
    expect(r.decision).toMatchObject({ ok: true, source: 'sandbox' });
  });

  it('reports which auth env names are mapped, never their values', async () => {
    const r = await resolvePageSource({
      get: null, repoFullName: null,
      gitConfig: { envMapping: { VERCEL_AUTOMATION_BYPASS_SECRET: 'vercel-bypass' } },
    });
    expect(r.auth.protectionBypass).toEqual({ env: 'VERCEL_AUTOMATION_BYPASS_SECRET', mapped: true });
    expect(r.auth.storageState.mapped).toBe(false);
    expect(JSON.stringify(r)).not.toContain('vercel-bypass');
  });

  it('rejects a non-hex sha', async () => {
    const r = await resolvePageSource({ get: github(ready), repoFullName: REPO, gitConfig: { visualQa: { pageSource: 'auto' } }, sha: 'main; rm -rf' });
    expect(r.preview).toMatchObject({ state: 'unreadable' });
  });
});

describe('resolvePageSource: the capture ref (visual-qa-auditor.md, "Which ref is captured")', () => {
  const BRANCH = 'mission/settings-abcd1234';
  const MISSION = { workingBranch: BRANCH, integrationBranchEnabled: true };
  const branchExists = { [`/repos/${REPO}/git/ref/heads/${BRANCH}`]: { ref: `refs/heads/${BRANCH}` } };

  it('mission-branch: captures the integration branch, and the preview commit is its head, not trunk', async () => {
    const get = github({ ...ready, ...branchExists });
    const r = await resolvePageSource({ get, repoFullName: REPO, gitConfig: { visualQa: { pageSource: 'auto' }, defaultBranch: 'dev' }, mission: MISSION });
    expect(r.captureRef).toEqual({ ref: BRANCH, source: 'mission_integration', integrationBase: BRANCH });
    expect(get.calls).toContain(`/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`);
    expect(get.calls).not.toContain(`/repos/${REPO}/commits/dev`);
  });

  it('mission-branch whose branch vanished: trunk, sourced integration_missing', async () => {
    const r = await resolvePageSource({ get: github(ready), repoFullName: REPO, gitConfig: { defaultBranch: 'dev' }, mission: MISSION });
    expect(r.captureRef).toEqual({ ref: 'dev', source: 'integration_missing', integrationBase: BRANCH });
  });

  it('an unreadable branch check is treated as present: falling back to trunk is the error this closes', async () => {
    const get = github({ ...ready, [`/repos/${REPO}/git/ref/heads/${BRANCH}`]: new Error('GitHub API error: 500 boom') });
    const r = await resolvePageSource({ get, repoFullName: REPO, gitConfig: { defaultBranch: 'dev' }, mission: MISSION });
    expect(r.captureRef.ref).toBe(BRANCH);
  });

  it('sandbox still names the capture ref; no mission or a direct mission is trunk with no branch check', async () => {
    const sandbox = await resolvePageSource({ get: github(branchExists), repoFullName: REPO, gitConfig: { defaultBranch: 'dev' }, mission: MISSION });
    expect(sandbox.decision).toMatchObject({ ok: true, source: 'sandbox' });
    expect(sandbox.captureRef.ref).toBe(BRANCH);
    const get = github(ready);
    const direct = await resolvePageSource({ get, repoFullName: REPO, gitConfig: { defaultBranch: 'dev' }, mission: { ...MISSION, integrationBranchEnabled: false } });
    expect(direct.captureRef).toEqual({ ref: 'dev', source: 'trunk', integrationBase: null });
    expect(get.calls).toHaveLength(0);
  });
});
