/**
 * register_skill / update_skill / delete_skill { personal: true }: a member's
 * own role, at worker level, through /api/roles. The team-role path of the
 * same actions stays admin-only, and a caller with no person behind it (a
 * per-task token, an API key) is refused before any API call.
 */
import { describe, it, expect, mock } from 'bun:test';
import {
  handleBuilddAction, isPersonalRoleCall, orchestrationTaskTokenRefusal, PERSONAL_ROLE_ACTIONS,
  adminActions, workerActions, type ApiFn, type ActionContext,
} from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const ROLE_ID = '00000000-0000-4000-8000-000000000042';

function ctx(level: 'trigger' | 'worker' | 'admin', principal?: ActionContext['principal']): ActionContext {
  return { workspaceId: WS_ID, getWorkspaceId: async () => WS_ID, getLevel: async () => level, principal };
}

type Call = { path: string; method: string; body: any };

function fakeApi(routes: Record<string, (body: any) => unknown>) {
  const calls: Call[] = [];
  const api = (async (path: string, opts: { method?: string; body?: string } = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path, method, body });
    const h = routes[`${method} ${path}`];
    if (!h) throw new Error(`API error: 404 - no route ${method} ${path}`);
    return h(body);
  }) as unknown as ApiFn;
  return { api, calls };
}

const ROLES = {
  roles: [
    { id: 'team-role', slug: 'helper', personal: undefined },
    { id: 'someone-elses', slug: 'helper', personal: true, mine: false, visibility: 'team' },
    { id: ROLE_ID, slug: 'helper', personal: true, mine: true, visibility: 'private' },
  ],
};

describe('the personal-role path is worker level; the team path stays admin', () => {
  it('lists the personal-path actions as admin actions with a personal path, not as worker actions', () => {
    for (const a of PERSONAL_ROLE_ACTIONS) {
      expect(adminActions as readonly string[]).toContain(a);
      expect(workerActions as readonly string[]).not.toContain(a);
    }
    expect(isPersonalRoleCall('register_skill', { personal: true })).toBe(true);
    expect(isPersonalRoleCall('register_skill', {})).toBe(false);
    expect(isPersonalRoleCall('manage_secrets', { personal: true })).toBe(false);
    expect(isPersonalRoleCall('list_skills', { personal: true })).toBe(true);
    expect(isPersonalRoleCall('get_skill', { personal: true })).toBe(true);
    expect(isPersonalRoleCall('list_skills', {})).toBe(false);
  });

  it('a worker-level person creates a personal role through POST /api/roles, never workspace skills', async () => {
    const { api, calls } = fakeApi({
      'POST /api/roles': () => ({ skill: { id: ROLE_ID, name: 'Helper', slug: 'helper', visibility: 'private' } }),
    });
    const result = await handleBuilddAction(api, 'register_skill', {
      personal: true, name: 'Helper', content: 'You help me', isRole: false, source: 'mcp', workspaceId: WS_ID, model: 'standard',
    }, ctx('worker', 'person'));
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/roles');
    expect(calls[0].body).toEqual({ name: 'Helper', content: 'You help me', model: 'standard', personal: true });
    expect(result.content[0].text).toContain('private');
  });

  it('visibility: "team" on create shares it right after', async () => {
    const { api, calls } = fakeApi({
      'POST /api/roles': () => ({ skill: { id: ROLE_ID, name: 'Helper', slug: 'helper', visibility: 'private' } }),
      [`POST /api/roles/${ROLE_ID}/share`]: () => ({ skill: { id: ROLE_ID, name: 'Helper', slug: 'helper', visibility: 'team' } }),
    });
    const result = await handleBuilddAction(api, 'register_skill', { personal: true, name: 'Helper', content: 'x', visibility: 'team' }, ctx('worker', 'person'));
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /api/roles', `POST /api/roles/${ROLE_ID}/share`]);
    expect(calls[1].body).toEqual({ visibility: 'team' });
    expect(result.content[0].text).toContain('Visibility: team');
  });

  it('a worker-level team-role create is refused as forbidden, with no API call', async () => {
    const { api, calls } = fakeApi({});
    const result = await handleBuilddAction(api, 'register_skill', { name: 'Helper', content: 'x' }, ctx('worker', 'person'));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'forbidden', requiredLevel: 'admin', tokenLevel: 'worker' });
    expect(calls).toHaveLength(0);
  });

  it('a trigger token cannot use the personal path', async () => {
    const { api, calls } = fakeApi({});
    const result = await handleBuilddAction(api, 'register_skill', { personal: true, name: 'H', content: 'x' }, ctx('trigger', 'key'));
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'forbidden', requiredLevel: 'worker' });
    expect(calls).toHaveLength(0);
  });

  for (const [principal, phrase] of [['task_token', 'per-task token'], ['key', 'API key']] as const) {
    for (const action of PERSONAL_ROLE_ACTIONS) {
      it(`refuses ${action} personal for a ${principal}: no person behind it, no API call`, async () => {
        const { api, calls } = fakeApi({});
        const result = await handleBuilddAction(api, action, { personal: true, name: 'H', content: 'x', slug: 'helper' }, ctx('worker', principal));
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(phrase);
        expect(calls).toHaveLength(0);
      });
    }
  }

  it("an orchestration task token's personal call is refused with the no-person reason", () => {
    expect(orchestrationTaskTokenRefusal('register_skill', { personal: true })).toContain('per-task token has no person');
    expect(orchestrationTaskTokenRefusal('register_skill', {})).toContain('team-wide');
  });
});

describe('update_skill / delete_skill { personal: true }', () => {
  it("resolves the slug to the caller's own role first, then patches and shares it", async () => {
    const { api, calls } = fakeApi({
      'GET /api/roles': () => ROLES,
      [`PATCH /api/roles/${ROLE_ID}`]: () => ({ skill: { id: ROLE_ID, name: 'Helper', slug: 'helper', visibility: 'private' } }),
      [`POST /api/roles/${ROLE_ID}/share`]: () => ({ skill: { id: ROLE_ID, name: 'Helper', slug: 'helper', visibility: 'team' } }),
    });
    const result = await handleBuilddAction(api, 'update_skill', {
      personal: true, slug: 'helper', description: 'better', visibility: 'team',
    }, ctx('worker', 'person'));
    expect(result.isError).toBeUndefined();
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /api/roles', `PATCH /api/roles/${ROLE_ID}`, `POST /api/roles/${ROLE_ID}/share`]);
    expect(calls[1].body).toEqual({ description: 'better' });
  });

  it('visibility alone only shares (no PATCH)', async () => {
    const { api, calls } = fakeApi({
      'GET /api/roles': () => ROLES,
      [`POST /api/roles/${ROLE_ID}/share`]: () => ({ skill: { id: ROLE_ID, slug: 'helper', visibility: 'private' } }),
    });
    await handleBuilddAction(api, 'update_skill', { personal: true, slug: 'helper', visibility: 'private' }, ctx('worker', 'person'));
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /api/roles', `POST /api/roles/${ROLE_ID}/share`]);
  });

  it("does not pre-refuse a shared role the caller does not own: the route decides", async () => {
    const { api, calls } = fakeApi({
      'GET /api/roles': () => ({ roles: [{ id: 'someone-elses', slug: 'shared-one', personal: true, mine: false }] }),
      'DELETE /api/roles/someone-elses': () => { throw new Error('API error: 403 - {"error":"Managing agent roles requires team admin"}'); },
    });
    await expect(handleBuilddAction(api, 'delete_skill', { personal: true, slug: 'shared-one' }, ctx('worker', 'person'))).rejects.toThrow('403');
    expect(calls.map(c => c.method)).toEqual(['GET', 'DELETE']);
  });

  it('deletes the caller\'s own role by slug', async () => {
    const { api, calls } = fakeApi({
      'GET /api/roles': () => ROLES,
      [`DELETE /api/roles/${ROLE_ID}`]: () => ({ success: true }),
    });
    const result = await handleBuilddAction(api, 'delete_skill', { personal: true, slug: 'helper' }, ctx('worker', 'person'));
    expect(result.content[0].text).toContain('deleted');
    expect(calls[1]).toMatchObject({ method: 'DELETE', path: `/api/roles/${ROLE_ID}` });
  });

  it('names a missing slug instead of falling back to a team skill', async () => {
    const { api, calls } = fakeApi({ 'GET /api/roles': () => ROLES });
    await expect(handleBuilddAction(api, 'delete_skill', { personal: true, slug: 'nope' }, ctx('worker', 'person'))).rejects.toThrow('No personal role with slug "nope"');
    expect(calls).toHaveLength(1);
  });

  it('refuses a bad visibility value', async () => {
    const { api } = fakeApi({});
    await expect(handleBuilddAction(api, 'update_skill', { personal: true, slug: 'helper', visibility: 'public' }, ctx('worker', 'person'))).rejects.toThrow('visibility');
  });
});

describe('list_skills / get_skill { personal: true }', () => {
  const VISIBLE = {
    roles: [
      { id: 'team-role', slug: 'builder', name: 'Builder' },
      { id: 'someone-elses', slug: 'helper', name: 'Their Helper', personal: true, mine: false, visibility: 'team', ownerName: 'Sam' },
      { id: ROLE_ID, slug: 'helper', name: 'My Helper', personal: true, mine: true, visibility: 'private', model: 'standard', description: 'helps me' },
    ],
  };

  it('a worker-level person lists their own and shared personal roles, never team roles, from GET /api/roles', async () => {
    const { api, calls } = fakeApi({ 'GET /api/roles': () => VISIBLE });
    const result = await handleBuilddAction(api, 'list_skills', { personal: true }, ctx('worker', 'person'));
    expect(result.isError).toBeUndefined();
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /api/roles']);
    const out = result.content[0].text;
    expect(out).toContain('2 personal role(s)');
    expect(out).toMatch(/My Helper.*\[private, yours, standard\]/);
    expect(out).toMatch(/Their Helper.*\[shared, by Sam\]/);
    expect(out).not.toContain('Builder');
  });

  it('says so when there is nothing to list', async () => {
    const { api } = fakeApi({ 'GET /api/roles': () => ({ roles: [{ id: 'team-role', slug: 'builder' }] }) });
    const result = await handleBuilddAction(api, 'list_skills', { personal: true }, ctx('worker', 'person'));
    expect(result.content[0].text).toContain('No personal roles');
  });

  it("get_skill reads the caller's own role first, in the shape update_skill takes", async () => {
    const { api, calls } = fakeApi({
      'GET /api/roles': () => VISIBLE,
      [`GET /api/roles/${ROLE_ID}`]: () => ({ skill: { id: ROLE_ID, slug: 'helper', name: 'My Helper', content: 'You help me', model: 'standard', visibility: 'private', ownerUserId: 'u1' } }),
    });
    const result = await handleBuilddAction(api, 'get_skill', { personal: true, slug: 'helper' }, ctx('worker', 'person'));
    expect(result.isError).toBeUndefined();
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /api/roles', `GET /api/roles/${ROLE_ID}`]);
    const out = result.content[0].text;
    const json = JSON.parse(out.slice(out.indexOf('\n{') + 1));
    expect(json).toMatchObject({ slug: 'helper', content: 'You help me', personal: true, visibility: 'private', mine: true });
    expect(json).not.toHaveProperty('ownerUserId');
  });

  it('get_skill falls back to a shared role the caller does not own', async () => {
    const { api, calls } = fakeApi({
      'GET /api/roles': () => ({ roles: [VISIBLE.roles[1]] }),
      'GET /api/roles/someone-elses': () => ({ skill: { id: 'someone-elses', slug: 'helper', name: 'Their Helper', content: 'x', visibility: 'team' } }),
    });
    const result = await handleBuilddAction(api, 'get_skill', { personal: true, slug: 'helper' }, ctx('worker', 'person'));
    expect(calls[1].path).toBe('/api/roles/someone-elses');
    expect(result.content[0].text).toContain('by Sam');
  });

  it('get_skill names a slug it cannot see, without falling back to workspace skills', async () => {
    const { api, calls } = fakeApi({ 'GET /api/roles': () => VISIBLE });
    await expect(handleBuilddAction(api, 'get_skill', { personal: true, slug: 'nope' }, ctx('worker', 'person'))).rejects.toThrow('No personal role with slug "nope"');
    expect(calls).toHaveLength(1);
  });

  it('a worker-level team list_skills / get_skill stays admin-only', async () => {
    const { api, calls } = fakeApi({});
    for (const [action, params] of [['list_skills', {}], ['get_skill', { slug: 'helper' }]] as const) {
      const result = await handleBuilddAction(api, action, params, ctx('worker', 'person'));
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'forbidden', requiredLevel: 'admin' });
    }
    expect(calls).toHaveLength(0);
  });
});
