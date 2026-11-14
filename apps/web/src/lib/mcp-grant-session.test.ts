/**
 * Workspace references on an account-level grant session resolve among the
 * granted workspaces only (lib/mcp-grants.ts resolveGrantWorkspaceRef), and a
 * refusal lists granted choices only and never echoes the reference
 * (lib/mcp-grant-session.ts). The SQL side (granted ∩ membership) is covered
 * on real Postgres in tests/db/mcp-canonical-transport.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { grantTokenScopes, resolveGrantWorkspaceRef, type GrantWorkspaceChoice } from './mcp-grants';
import { GRANT_CHOICES_SHOWN, grantCreateTarget, grantWorkspaceRefusal } from './mcp-grant-session';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const UNGRANTED = '44444444-4444-4444-8444-444444444444';

const choice = (workspaceId: string, name: string, repo: string | null, teamId = 't1'): GrantWorkspaceChoice =>
  ({ workspaceId, name, repo, teamId, teamName: teamId, level: 'worker', access: 'read-write' });

const choices = [choice(A, 'web', 'acme/web'), choice(B, 'web', 'other/web', 't2'), choice(C, 'api', 'acme/api')];

describe('resolveGrantWorkspaceRef', () => {
  it('no reference: the only workspace, else required', () => {
    expect(resolveGrantWorkspaceRef([choices[0]], null)).toMatchObject({ kind: 'ok', workspace: { workspaceId: A } });
    expect(resolveGrantWorkspaceRef(choices, undefined)).toMatchObject({ kind: 'required' });
    expect(resolveGrantWorkspaceRef(choices, '  ')).toMatchObject({ kind: 'required' });
  });

  it('a granted UUID resolves; any other UUID is not_granted', () => {
    expect(resolveGrantWorkspaceRef(choices, C.toUpperCase())).toMatchObject({ kind: 'ok', workspace: { workspaceId: C } });
    expect(resolveGrantWorkspaceRef(choices, UNGRANTED)).toMatchObject({ kind: 'not_granted' });
  });

  it('owner/repo in any stored form resolves exactly, never by substring', () => {
    expect(resolveGrantWorkspaceRef(choices, 'acme/web')).toMatchObject({ kind: 'ok', workspace: { workspaceId: A } });
    expect(resolveGrantWorkspaceRef(choices, 'https://github.com/Acme/Web.git')).toMatchObject({ kind: 'ok', workspace: { workspaceId: A } });
    expect(resolveGrantWorkspaceRef(choices, 'acme/we')).toMatchObject({ kind: 'not_granted' });
  });

  it('a name matching several granted workspaces is ambiguous, with only those as choices', () => {
    const r = resolveGrantWorkspaceRef(choices, 'web');
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.choices.map((c) => c.workspaceId).sort()).toEqual([A, B].sort());
    expect(resolveGrantWorkspaceRef(choices, 'API')).toMatchObject({ kind: 'ok', workspace: { workspaceId: C } });
  });
});

describe('grantWorkspaceRefusal', () => {
  it('names granted choices only and never the reference', () => {
    const r = resolveGrantWorkspaceRef(choices, UNGRANTED);
    if (r.kind === 'ok') throw new Error('expected a refusal');
    const text = grantWorkspaceRefusal(r).content[0].text;
    expect(JSON.parse(text).error).toBe('workspace_not_granted');
    expect(text).not.toContain(UNGRANTED);
    for (const id of [A, B, C]) expect(text).toContain(id);
  });

  it('caps the listed choices and says how many more there are', () => {
    const many = Array.from({ length: GRANT_CHOICES_SHOWN + 3 }, (_, i) => choice(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, `w${i}`, null));
    const body = JSON.parse(grantWorkspaceRefusal({ kind: 'required', choices: many }).content[0].text);
    expect(body.choices.length).toBe(GRANT_CHOICES_SHOWN);
    expect(body.more).toBe(3);
  });
});

describe('grantTokenScopes', () => {
  it('a read-only grant reads only; a write grant keeps role-level permissions', () => {
    expect(grantTokenScopes(['read'])).toEqual(['tasks:read', 'analytics:read']);
    expect(grantTokenScopes(['read', 'write'])).toBeNull();
  });
});

describe('grantCreateTarget (manage_workspaces create on an account-level connection)', () => {
  const create = (params: Record<string, unknown> = {}) => ({ action: 'manage_workspaces', params: { action: 'create', name: 'n', ...params } });
  const refusalBody = (r: ReturnType<typeof grantCreateTarget>) => {
    if (!r || r.kind !== 'refused') throw new Error('expected a refusal');
    return JSON.parse(r.result.content[0].text);
  };

  it('is not applicable to any other call', () => {
    expect(grantCreateTarget({ action: 'manage_workspaces', params: { action: 'list' } }, choices)).toBeNull();
    expect(grantCreateTarget({ action: 'list_tasks', params: {} }, choices)).toBeNull();
    expect(grantCreateTarget(undefined, choices)).toBeNull();
  });

  it('one reachable team: binds to a workspace in it and passes its teamId on', () => {
    const args = create();
    const r = grantCreateTarget(args, [choices[0], choices[2]]);
    expect(r).toMatchObject({ kind: 'ok', workspace: { teamId: 't1' } });
    expect(args.params.teamId).toBe('t1');
  });

  it('several teams and none named: refused with the team choices, nothing picked', () => {
    const body = refusalBody(grantCreateTarget(create(), choices));
    expect(body.error).toBe('team_required');
    expect(body.teams.map((t: { teamId: string }) => t.teamId).sort()).toEqual(['t1', 't2']);
  });

  it('a team named by id or by name resolves among reachable teams only', () => {
    expect(grantCreateTarget(create({ teamId: 't2' }), choices)).toMatchObject({ kind: 'ok', workspace: { workspaceId: B } });
    const byName = create({ team: 'T2' });
    expect(grantCreateTarget(byName, choices)).toMatchObject({ kind: 'ok', workspace: { teamId: 't2' } });
    expect(byName.params.teamId).toBe('t2');
    // A team name passed in teamId works too.
    expect(grantCreateTarget(create({ teamId: 't1' }), choices)).toMatchObject({ kind: 'ok', workspace: { teamId: 't1' } });
  });

  it("the connection's own default workspace anchors a create that names no team", () => {
    expect(grantCreateTarget(create(), choices, choices[1])).toMatchObject({ kind: 'ok', workspace: { teamId: 't2' } });
  });

  it('a team the connection does not reach is refused and never echoed', () => {
    const r = grantCreateTarget(create({ teamId: UNGRANTED }), choices);
    const body = refusalBody(r);
    expect(body.error).toBe('team_not_granted');
    expect(JSON.stringify(body)).not.toContain(UNGRANTED);
  });

  it('a workspaceId with no team named anchors the create in that workspace\'s team', () => {
    const args = create({ workspaceId: B });
    expect(grantCreateTarget(args, choices)).toMatchObject({ kind: 'ok', workspace: { workspaceId: B } });
    expect(args.params.teamId).toBe('t2');
    expect(refusalBody(grantCreateTarget(create({ workspaceId: UNGRANTED }), choices)).error).toBe('workspace_not_granted');
  });
});
