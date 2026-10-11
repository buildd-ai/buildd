import { describe, it, expect } from 'bun:test';
import {
  assertMemberRepoAccess,
  checkMemberRepoAccess,
  filterWorkspacesByMemberRepoAccess,
  linkGitHubUrl,
  memberRepoAccessMessage,
  memberRepoAccessSubject,
  resolveMemberRepoAccessMode,
  type GitHubReply,
  type MemberRepoAccessDeps,
  type MemberRepoAccessResult,
  type WorkspaceRepoFacts,
} from './member-repo-access';

const ON: WorkspaceRepoFacts = { mode: 'require_read', repoFullName: 'acme/widgets', installationId: 4242 };

function deps(opts: {
  ws?: WorkspaceRepoFacts | null | Error;
  githubId?: string | null;
  replies?: Record<string, GitHubReply | Error>;
} = {}) {
  const calls: string[] = [];
  const cache = new Map<string, MemberRepoAccessResult>();
  const d: MemberRepoAccessDeps = {
    async loadWorkspace() {
      if (opts.ws instanceof Error) throw opts.ws;
      return opts.ws === undefined ? ON : opts.ws;
    },
    async loadGithubId() { return opts.githubId === undefined ? '1001' : opts.githubId; },
    async github(_inst, path) {
      calls.push(path);
      const r = opts.replies?.[path];
      if (r instanceof Error) throw r;
      return r ?? { status: 500, body: null };
    },
    async cacheGet(k) { return cache.get(k) ?? null; },
    async cacheSet(k, v) { cache.set(k, v); },
  };
  return { d, calls, cache };
}

const USER_OK = { '/user/1001': { status: 200, body: { login: 'octo' } } };
const perm = (status: number, permission?: string): Record<string, GitHubReply> => ({
  ...USER_OK,
  '/repos/acme/widgets/collaborators/octo/permission': { status, body: permission ? { permission } : null },
});

describe('checkMemberRepoAccess', () => {
  it('setting off: allowed without asking GitHub', async () => {
    const { d, calls } = deps({ ws: { ...ON, mode: 'off' }, githubId: null });
    expect(await checkMemberRepoAccess('u1', 'w1', d)).toEqual({ allowed: true, reason: 'off', repoFullName: 'acme/widgets' });
    expect(calls).toEqual([]);
  });

  it('collaborator with read passes', async () => {
    const { d } = deps({ replies: perm(200, 'read') });
    expect(await checkMemberRepoAccess('u1', 'w1', d)).toMatchObject({ allowed: true, reason: 'collaborator' });
  });

  it('write and admin pass too', async () => {
    for (const p of ['write', 'admin', 'maintain', 'triage']) {
      const { d } = deps({ replies: perm(200, p) });
      expect((await checkMemberRepoAccess('u1', 'w1', d)).allowed).toBe(true);
    }
  });

  it('permission none is not a collaborator', async () => {
    const { d } = deps({ replies: perm(200, 'none') });
    expect(await checkMemberRepoAccess('u1', 'w1', d)).toMatchObject({ allowed: false, reason: 'not_collaborator' });
  });

  it('404 on the permission endpoint is not a collaborator', async () => {
    const { d } = deps({ replies: perm(404) });
    expect(await checkMemberRepoAccess('u1', 'w1', d)).toMatchObject({ allowed: false, reason: 'not_collaborator' });
  });

  it('no linked GitHub account', async () => {
    const { d, calls } = deps({ githubId: null });
    expect(await checkMemberRepoAccess('u1', 'w1', d)).toMatchObject({ allowed: false, reason: 'no_github_link' });
    expect(calls).toEqual([]);
  });

  it('404 on the user lookup: the linked account is gone', async () => {
    const { d } = deps({ replies: { '/user/1001': { status: 404, body: null } } });
    expect(await checkMemberRepoAccess('u1', 'w1', d)).toMatchObject({ allowed: false, reason: 'no_github_link' });
  });

  it('GitHub API error fails closed', async () => {
    const { d } = deps({ replies: perm(500) });
    expect(await checkMemberRepoAccess('u1', 'w1', d)).toMatchObject({ allowed: false, reason: 'check_failed' });
  });

  it('a thrown fetch fails closed', async () => {
    const { d } = deps({ replies: { '/user/1001': new Error('network') } });
    expect(await checkMemberRepoAccess('u1', 'w1', d)).toMatchObject({ allowed: false, reason: 'check_failed' });
  });

  it('403 (App lacks the permission) fails closed', async () => {
    const { d } = deps({ replies: perm(403) });
    expect(await checkMemberRepoAccess('u1', 'w1', d)).toMatchObject({ allowed: false, reason: 'check_failed' });
  });

  it('setting on with no linked repo fails closed', async () => {
    const { d } = deps({ ws: { ...ON, repoFullName: null, installationId: null } });
    expect(await checkMemberRepoAccess('u1', 'w1', d)).toMatchObject({ allowed: false, reason: 'check_failed' });
  });

  it('cannot read the workspace: fails closed, not off', async () => {
    expect(await checkMemberRepoAccess('u1', 'w1', deps({ ws: new Error('db') }).d)).toMatchObject({ allowed: false, reason: 'check_failed' });
    expect(await checkMemberRepoAccess('u1', 'w1', deps({ ws: null }).d)).toMatchObject({ allowed: false, reason: 'check_failed' });
  });

  it('caches GitHub answers, not failures', async () => {
    const ok = deps({ replies: perm(200, 'read') });
    await checkMemberRepoAccess('u1', 'w1', ok.d);
    await checkMemberRepoAccess('u1', 'w1', ok.d);
    expect(ok.calls.length).toBe(2); // one user + one permission call, then cached

    const bad = deps({ replies: perm(502) });
    await checkMemberRepoAccess('u1', 'w1', bad.d);
    expect(bad.cache.size).toBe(0);
  });
});

describe('assertMemberRepoAccess', () => {
  it('no person (API key, runner) always proceeds', async () => {
    expect(await assertMemberRepoAccess(null, 'w1', deps({ githubId: null }).d)).toBeNull();
  });

  it('a refused member gets a 403 with the reason', async () => {
    const res = await assertMemberRepoAccess('u1', 'w1', deps({ replies: perm(200, 'none') }).d);
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toBe('member_repo_access');
    expect(body.reason).toBe('not_collaborator');
    expect(body.message).toContain('acme/widgets');
  });

  it('an allowed member proceeds', async () => {
    expect(await assertMemberRepoAccess('u1', 'w1', deps({ replies: perm(200, 'read') }).d)).toBeNull();
  });
});

describe('filterWorkspacesByMemberRepoAccess', () => {
  it('keeps off workspaces without asking, drops refused ones', async () => {
    const { d, calls } = deps({ githubId: null });
    const kept = await filterWorkspacesByMemberRepoAccess('u1', ['a', 'b'], {
      deps: d,
      gitConfigOf: id => (id === 'a' ? {} : { memberRepoAccess: 'require_read' }),
    });
    expect([...kept]).toEqual(['a']);
    expect(calls).toEqual([]);
  });
});

describe('helpers', () => {
  it('mode defaults to off', () => {
    expect(resolveMemberRepoAccessMode(null)).toBe('off');
    expect(resolveMemberRepoAccessMode({ memberRepoAccess: 'bogus' })).toBe('off');
    expect(resolveMemberRepoAccessMode({ memberRepoAccess: 'require_read' })).toBe('require_read');
  });

  it('subject is the person: session user or OAuth session user, never a key', () => {
    expect(memberRepoAccessSubject(null, { id: 'u1' })).toBe('u1');
    expect(memberRepoAccessSubject({ sessionUserId: 'u2' }, null)).toBe('u2');
    expect(memberRepoAccessSubject({}, { id: 'u1' })).toBeNull();
  });

  it('messages are one line per reason', () => {
    expect(memberRepoAccessMessage({ allowed: true, reason: 'collaborator' })).toBeNull();
    for (const reason of ['no_github_link', 'not_collaborator', 'check_failed'] as const) {
      const m = memberRepoAccessMessage({ allowed: false, reason, repoFullName: 'acme/widgets' })!;
      expect(m).not.toContain('\n');
    }
  });

  it('link URL goes through the GitHub sign-in link flow', () => {
    expect(linkGitHubUrl('/app/x?y=1')).toBe('/app/auth/signin?provider=github&callbackUrl=%2Fapp%2Fx%3Fy%3D1');
  });
});
