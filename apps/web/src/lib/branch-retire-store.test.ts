import { describe, it, expect } from 'bun:test';
import { retireBranchIfDead, retireClosedPrBranch, sweepRepo, encodeRef, type BranchOwnership, type BranchRetireDeps, type RepoScope, type SweepResult } from './branch-retire-store';

const NOW = new Date('2026-11-06T12:00:00Z');
const DAY = 86_400_000;
const REPO = 'acme/app';
const scope: RepoScope = { repoFullName: REPO, installationId: 1, trunkBranches: ['dev'], workspaceIds: ['w'], candidatePatterns: ['release/v*'] };

interface FakeBranch { sha: string; date: string; protected?: boolean }
interface FakePr { number: number; state: 'open' | 'closed'; merged?: boolean; head: string; headSha: string; base: string; fork?: boolean }

function fakeGithub(branches: Record<string, FakeBranch>, prs: FakePr[], inTrunk: Set<string> = new Set()) {
  const calls: string[] = [];
  const deleted: string[] = [];
  const api = async (_i: number, path: string, init?: RequestInit): Promise<unknown> => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const url = new URL(`https://x${path}`);
    const p = url.pathname.replace(`/repos/${REPO}`, '');
    if (p === '') return { default_branch: 'dev' };
    if (init?.method === 'DELETE') {
      const name = decodeURIComponent(p.replace('/git/refs/heads/', ''));
      if (!branches[name]) throw new Error('GitHub API error: 422 Reference does not exist');
      delete branches[name]; deleted.push(name); return null;
    }
    if (p.startsWith('/branches/')) {
      const name = decodeURIComponent(p.slice('/branches/'.length));
      const b = branches[name];
      if (!b) throw new Error('GitHub API error: 404 Branch not found');
      return { protected: !!b.protected, commit: { sha: b.sha, commit: { committer: { date: b.date } } } };
    }
    if (p === '/branches') return Object.keys(branches).map((name) => ({ name, protected: !!branches[name].protected }));
    if (p === '/pulls') {
      const state = url.searchParams.get('state'); const head = url.searchParams.get('head'); const base = url.searchParams.get('base');
      return prs
        .filter((x) => state === 'all' || x.state === state)
        .filter((x) => !head || `acme:${x.head}` === head)
        .filter((x) => !base || x.base === base)
        .map((x) => ({
          number: x.number, state: x.state, merged_at: x.merged ? '2026-11-05T00:00:00Z' : null, closed_at: x.state === 'closed' ? '2026-11-05T00:00:00Z' : null,
          head: { ref: x.head, sha: x.headSha, repo: { full_name: x.fork ? 'someone/app' : REPO } }, base: { ref: x.base },
        }));
    }
    if (p.startsWith('/compare/')) return { status: inTrunk.has(p.split('...')[1]) ? 'behind' : 'diverged' };
    throw new Error(`unexpected ${path}`);
  };
  return { api, calls, deleted };
}

const owners = (m: Record<string, BranchOwnership>) => async (_s: RepoScope, b: string): Promise<BranchOwnership> => m[b] ?? { owner: null, referencedByLiveTask: false };
const ended = { owner: { kind: 'task' as const, taskStatuses: ['completed'] }, referencedByLiveTask: false };
const old = new Date(NOW.getTime() - 30 * DAY).toISOString();

function deps(gh: ReturnType<typeof fakeGithub>, own: Record<string, BranchOwnership>): BranchRetireDeps {
  return { api: gh.api, ownership: owners(own), now: () => NOW };
}

describe('retireBranchIfDead', () => {
  it('deletes the head of a PR closed unmerged (superseded / close_pr) and of a merged PR GitHub left behind', async () => {
    const gh = fakeGithub(
      { 'buildd/aaaaaaaa-x': { sha: 's1', date: old }, 'buildd/bbbbbbbb-y': { sha: 's2', date: old } },
      [{ number: 1, state: 'closed', head: 'buildd/aaaaaaaa-x', headSha: 's1', base: 'dev' }, { number: 2, state: 'closed', merged: true, head: 'buildd/bbbbbbbb-y', headSha: 's2', base: 'dev' }],
    );
    const d = deps(gh, { 'buildd/aaaaaaaa-x': ended, 'buildd/bbbbbbbb-y': ended });
    expect(await retireBranchIfDead(scope, 'buildd/aaaaaaaa-x', d)).toEqual({ action: 'delete', reason: 'pr_closed_unmerged', deleted: true });
    expect(await retireBranchIfDead(scope, 'buildd/bbbbbbbb-y', d)).toEqual({ action: 'delete', reason: 'pr_merged', deleted: true });
    expect(gh.deleted).toEqual(['buildd/aaaaaaaa-x', 'buildd/bbbbbbbb-y']);
    // The ref is path-encoded per segment, never as one %2F blob.
    expect(gh.calls).toContain('DELETE /repos/acme/app/git/refs/heads/buildd/aaaaaaaa-x');
  });

  it('a branch buildd did not make costs no GitHub read and is kept', async () => {
    const gh = fakeGithub({ 'feat/mine': { sha: 's', date: old } }, [{ number: 3, state: 'closed', head: 'feat/mine', headSha: 's', base: 'dev' }]);
    expect(await retireBranchIfDead(scope, 'feat/mine', deps(gh, {}))).toEqual({ action: 'keep', reason: 'not_buildd_branch', deleted: false });
    expect(gh.calls).toEqual([]);
  });

  it('keeps a branch whose task is still running, and a live mission\'s branch after its ship PR merged', async () => {
    const gh = fakeGithub(
      { 'buildd/cccccccc-z': { sha: 's', date: old }, 'mission/m-12345678': { sha: 'm', date: old } },
      [{ number: 4, state: 'closed', head: 'buildd/cccccccc-z', headSha: 's', base: 'dev' }, { number: 5, state: 'closed', merged: true, head: 'mission/m-12345678', headSha: 'm', base: 'dev' }],
    );
    const d = deps(gh, {
      'buildd/cccccccc-z': { owner: { kind: 'task', taskStatuses: ['in_progress'] }, referencedByLiveTask: false },
      'mission/m-12345678': { owner: { kind: 'mission', missionStatuses: ['active'] }, referencedByLiveTask: false },
    });
    expect((await retireBranchIfDead(scope, 'buildd/cccccccc-z', d)).reason).toBe('task_live');
    expect((await retireBranchIfDead(scope, 'mission/m-12345678', d)).reason).toBe('mission_live');
    expect(gh.deleted).toEqual([]);
  });

  it('keeps an open release candidate and deletes a finished one', async () => {
    const gh = fakeGithub(
      { 'release/v1.0.0': { sha: 'r1', date: old }, 'release/v1.0.1': { sha: 'r2', date: old } },
      [{ number: 6, state: 'closed', merged: true, head: 'release/v1.0.0', headSha: 'r1', base: 'main' }, { number: 7, state: 'open', head: 'release/v1.0.1', headSha: 'r2', base: 'main' }],
    );
    const rc = { owner: { kind: 'release_candidate' as const }, referencedByLiveTask: false };
    const d = deps(gh, { 'release/v1.0.0': rc, 'release/v1.0.1': rc });
    expect((await retireBranchIfDead(scope, 'release/v1.0.1', d)).reason).toBe('open_pr');
    expect((await retireBranchIfDead(scope, 'release/v1.0.0', d)).deleted).toBe(true);
  });

  it('keeps commits pushed after the PR ended unless they are in trunk (reads compare only then)', async () => {
    const gh = fakeGithub(
      { 'buildd/dddddddd-a': { sha: 'later', date: old }, 'buildd/eeeeeeee-b': { sha: 'merged-later', date: old } },
      [{ number: 8, state: 'closed', head: 'buildd/dddddddd-a', headSha: 'earlier', base: 'dev' }, { number: 9, state: 'closed', merged: true, head: 'buildd/eeeeeeee-b', headSha: 'x', base: 'dev' }],
      new Set(['merged-later']),
    );
    const d = deps(gh, { 'buildd/dddddddd-a': ended, 'buildd/eeeeeeee-b': ended });
    expect((await retireBranchIfDead(scope, 'buildd/dddddddd-a', d)).reason).toBe('unshipped_commits_after_pr');
    expect(await retireBranchIfDead(scope, 'buildd/eeeeeeee-b', d)).toEqual({ action: 'delete', reason: 'pr_merged', deleted: true });
    expect(gh.calls.filter((c) => c.includes('/compare/'))).toHaveLength(2);
  });

  it('a PR-less branch of an ended task: kept while young, deleted when old', async () => {
    const young = new Date(NOW.getTime() - DAY).toISOString();
    const gh = fakeGithub({ 'buildd/ffffffff--reviewer-pr-1': { sha: 'y', date: young }, 'buildd/11111111--ci-retry-1-x': { sha: 'o', date: old } }, []);
    const d = deps(gh, { 'buildd/ffffffff--reviewer-pr-1': ended, 'buildd/11111111--ci-retry-1-x': ended });
    expect((await retireBranchIfDead(scope, 'buildd/ffffffff--reviewer-pr-1', d)).reason).toBe('no_pr_young');
    expect(await retireBranchIfDead(scope, 'buildd/11111111--ci-retry-1-x', d)).toEqual({ action: 'delete', reason: 'no_pr_task_ended', deleted: true });
  });

  it('a branch already gone, or a delete that races GitHub, is fine; a failed read keeps the branch', async () => {
    const gh = fakeGithub({}, []);
    expect((await retireBranchIfDead(scope, 'buildd/22222222-gone', deps(gh, { 'buildd/22222222-gone': ended }))).reason).toBe('gone');
    const broken: BranchRetireDeps = { api: async () => { throw new Error('GitHub API error: 500 boom'); }, ownership: owners({ 'buildd/33333333-x': ended }), now: () => NOW };
    expect(await retireBranchIfDead(scope, 'buildd/33333333-x', broken)).toEqual({ action: 'keep', reason: 'unreadable', deleted: false });
  });

  it('trunk is never read, let alone deleted', async () => {
    const gh = fakeGithub({ dev: { sha: 'd', date: old } }, []);
    expect((await retireBranchIfDead(scope, 'dev', deps(gh, { dev: ended }))).reason).toBe('trunk');
    expect((await retireBranchIfDead(scope, 'main', deps(gh, { main: ended }))).reason).toBe('trunk');
    expect(gh.calls).toEqual([]);
  });
});

describe('retireClosedPrBranch', () => {
  it('never touches a fork\'s branch', async () => {
    expect(await retireClosedPrBranch({ repoFullName: REPO, installationId: 1, headRef: 'patch-1', headRepoFullName: 'someone/app' })).toBeNull();
  });
  it('needs an installation and a head', async () => {
    expect(await retireClosedPrBranch({ repoFullName: REPO, installationId: null, headRef: 'x', headRepoFullName: REPO })).toBeNull();
    expect(await retireClosedPrBranch({ repoFullName: REPO, installationId: 1, headRef: null, headRepoFullName: REPO })).toBeNull();
  });
});

describe('sweepRepo', () => {
  it('applies the same keep-rules to every branch and counts what it kept', async () => {
    const gh = fakeGithub(
      {
        dev: { sha: 'd', date: old, protected: true },
        'buildd/aaaaaaaa-dead': { sha: 'a', date: old },
        'buildd/bbbbbbbb-open': { sha: 'b', date: old },
        'mission/live-12345678': { sha: 'm', date: old },
        'feat/human': { sha: 'h', date: old },
      },
      [
        { number: 1, state: 'closed', head: 'buildd/aaaaaaaa-dead', headSha: 'a', base: 'dev' },
        { number: 2, state: 'open', head: 'buildd/bbbbbbbb-open', headSha: 'b', base: 'mission/live-12345678' },
      ],
    );
    const d = deps(gh, {
      'buildd/aaaaaaaa-dead': ended,
      'buildd/bbbbbbbb-open': { owner: { kind: 'task', taskStatuses: ['in_progress'] }, referencedByLiveTask: false },
      'mission/live-12345678': { owner: { kind: 'mission', missionStatuses: ['active'] }, referencedByLiveTask: false },
    });
    const result: SweepResult = { repos: 0, listed: 0, evaluated: 0, deleted: 0, kept: {}, truncated: false };
    await sweepRepo(scope, 'dev', d, result);
    expect(gh.deleted).toEqual(['buildd/aaaaaaaa-dead']);
    expect(result).toMatchObject({ repos: 1, listed: 4, deleted: 1, truncated: false });
    expect(result.kept).toEqual({ open_pr: 1, open_pr_based_on_it: 1, not_buildd_branch: 1 });
  });
});

describe('encodeRef', () => {
  it('encodes each segment, keeping the slashes', () => {
    expect(encodeRef('buildd/ab#c')).toBe('buildd/ab%23c');
  });
});
