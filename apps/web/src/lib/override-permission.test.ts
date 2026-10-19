import { describe, expect, test } from 'bun:test';
import { checkReviewOverridePermission, escalationPermissionsOf, reviewOverrideRefusalSentence, type ReviewOverrideDeps } from './override-permission';

const WS = { teamId: 't1', gitConfig: {} as unknown, repoFullName: 'acme/web', installationId: 42 };

function deps(o: {
  ws?: Partial<typeof WS> | null; role?: string | null; githubId?: string | null;
  login?: number; permission?: { status: number; body?: unknown };
} = {}): ReviewOverrideDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loadWorkspace: async () => (o.ws === null ? null : { ...WS, ...o.ws }),
    loadTeamRole: async () => (o.role === undefined ? 'admin' : o.role),
    loadGithubId: async () => (o.githubId === undefined ? '1001' : o.githubId),
    github: async (_inst, path) => {
      calls.push(path);
      if (path.startsWith('/user/')) return { status: o.login ?? 200, body: { login: 'octo' } };
      return o.permission ?? { status: 200, body: { permission: 'write' } };
    },
  };
}

describe('approve and override: who may take it', () => {
  test('an admin with write on the repo under the default policy may override', async () => {
    const d = deps();
    expect(await checkReviewOverridePermission('u1', 'w1', d)).toEqual({ overridePermitted: true, hasMergePermission: true, refusal: null });
    expect(d.calls).toEqual(['/user/1001', '/repos/acme/web/collaborators/octo/permission']);
  });

  test('owner, maintain and admin on GitHub count as merge permission', async () => {
    for (const permission of ['maintain', 'admin']) {
      expect((await checkReviewOverridePermission('u1', 'w1', deps({ role: 'owner', permission: { status: 200, body: { permission } } }))).hasMergePermission).toBe(true);
    }
  });

  test('a policy set to off refuses everyone, without asking GitHub', async () => {
    const d = deps({ ws: { gitConfig: { mergePolicy: { tier: 'agent-review', reviewOverride: 'off' } } } });
    const r = await checkReviewOverridePermission('u1', 'w1', d);
    expect(r).toMatchObject({ overridePermitted: false, refusal: 'policy_off' });
    expect(d.calls).toEqual([]);
  });

  test('a team member who is not owner or admin is refused', async () => {
    const r = await checkReviewOverridePermission('u1', 'w1', deps({ role: 'member' }));
    expect(r).toMatchObject({ overridePermitted: false, refusal: 'role' });
  });

  test('no team role at all is refused', async () => {
    expect((await checkReviewOverridePermission('u1', 'w1', deps({ role: null }))).refusal).toBe('role');
  });

  test('read or triage on GitHub is not merge permission', async () => {
    for (const permission of ['read', 'triage', 'none']) {
      const r = await checkReviewOverridePermission('u1', 'w1', deps({ permission: { status: 200, body: { permission } } }));
      expect(r).toEqual({ overridePermitted: true, hasMergePermission: false, refusal: 'no_merge_permission' });
    }
  });

  test('not a collaborator, no GitHub link, or GitHub not answering fails closed', async () => {
    expect((await checkReviewOverridePermission('u1', 'w1', deps({ permission: { status: 404 } }))).refusal).toBe('no_merge_permission');
    expect((await checkReviewOverridePermission('u1', 'w1', deps({ githubId: null }))).refusal).toBe('no_github_link');
    expect((await checkReviewOverridePermission('u1', 'w1', deps({ permission: { status: 502 } }))).refusal).toBe('check_failed');
    expect((await checkReviewOverridePermission('u1', 'w1', deps({ ws: { installationId: null as never } }))).refusal).toBe('check_failed');
    expect((await checkReviewOverridePermission('u1', 'w1', deps({ ws: null }))).refusal).toBe('check_failed');
    const throws: ReviewOverrideDeps = { ...deps(), github: async () => { throw new Error('boom'); } };
    expect((await checkReviewOverridePermission('u1', 'w1', throws)).hasMergePermission).toBe(false);
  });

  test('every refusal is a plain sentence', () => {
    for (const r of ['policy_off', 'role', 'no_merge_permission', 'no_github_link', 'check_failed'] as const) {
      const s = reviewOverrideRefusalSentence(r, 'acme/web');
      expect(s).toMatch(/^[A-Z].*\.$/);
      expect(s).not.toMatch(/_/);
    }
  });

  test('the brief gets both readings and the refusal sentence', () => {
    expect(escalationPermissionsOf({ overridePermitted: false, hasMergePermission: false, refusal: 'role' }))
      .toEqual({ overridePermitted: false, hasMergePermission: false, overrideUnavailableReason: 'Only a team owner or admin can approve past remaining findings.' });
    expect(escalationPermissionsOf({ overridePermitted: true, hasMergePermission: true, refusal: null }).overrideUnavailableReason).toBeNull();
  });
});
