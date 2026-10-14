import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { assertGrantedWorkspace, constrainToGranted, isGrantSession } from './grant-scope';
import { accountReachesWorkspace } from './workspace-reach';
import { canAccessTokenRoute } from './token-route-policy';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TEAM = 'team-a';

const writeGrant = { oauthGrantId: 'g-1', grantScopes: ['read', 'write'], workspaceIds: [WS], scopes: null };
const readGrant = { oauthGrantId: 'g-2', grantScopes: ['read'], workspaceIds: [WS], scopes: ['tasks:read', 'analytics:read'] };
const scopedKey = { workspaceIds: [WS], scopes: ['tasks:write'] };
const legacy = { workspaceIds: null, scopes: null };

describe('assertGrantedWorkspace', () => {
  test('a grant session: its workspaces only, writes only with the write scope', () => {
    expect(assertGrantedWorkspace(writeGrant, WS, 'write')).toBe(true);
    expect(assertGrantedWorkspace(writeGrant, OTHER, 'read')).toBe(false);
    expect(assertGrantedWorkspace(writeGrant, null, 'read')).toBe(false);
    expect(assertGrantedWorkspace(readGrant, WS, 'read')).toBe(true);
    expect(assertGrantedWorkspace(readGrant, WS, 'write')).toBe(false);
  });

  test('a grant session with no workspace list reaches nothing (fail closed)', () => {
    expect(assertGrantedWorkspace({ oauthGrantId: 'g', grantScopes: ['write'], workspaceIds: null }, WS, 'read')).toBe(false);
  });

  test('a scoped key is confined to its list; an unrestricted credential defers to the usual rule', () => {
    expect(assertGrantedWorkspace(scopedKey, WS, 'write')).toBe(true);
    expect(assertGrantedWorkspace(scopedKey, OTHER, 'read')).toBe(false);
    expect(assertGrantedWorkspace(legacy, OTHER, 'write')).toBe(true);
    expect(assertGrantedWorkspace(null, WS, 'read')).toBe(false);
  });

  test('constrainToGranted narrows, never widens', () => {
    expect(constrainToGranted(writeGrant, [WS, OTHER])).toEqual([WS]);
    expect(constrainToGranted(readGrant, [WS, OTHER], 'write')).toEqual([]);
    expect(constrainToGranted(legacy, [WS, OTHER])).toEqual([WS, OTHER]);
    expect(constrainToGranted(writeGrant, [OTHER])).toEqual([]);
  });

  test('only a grant id makes a grant session', () => {
    expect(isGrantSession(writeGrant)).toBe(true);
    expect(isGrantSession({ oauthGrantId: null })).toBe(false);
    expect(isGrantSession({ oauthGrantId: '' })).toBe(false);
    expect(isGrantSession(scopedKey)).toBe(false);
  });
});

describe('accountReachesWorkspace: the restricted-mode exception is for grant sessions only', () => {
  const restricted = { id: WS, teamId: TEAM, accessMode: 'restricted' };
  const openSibling = { id: OTHER, teamId: TEAM, accessMode: 'open' };

  test('a grant session reaches a restricted workspace it was granted without a link, and no open sibling', () => {
    const g = { teamId: TEAM, ...writeGrant };
    expect(accountReachesWorkspace(g, restricted, null)).toBe(true);
    expect(accountReachesWorkspace(g, restricted, null, 'canCreate')).toBe(true);
    expect(accountReachesWorkspace(g, openSibling, null)).toBe(false);
    // Even a link on the shared account does not widen it.
    expect(accountReachesWorkspace(g, openSibling, { canClaim: true, canCreate: true })).toBe(false);
    // No id on the workspace: no answer but no.
    expect(accountReachesWorkspace(g, { teamId: TEAM, accessMode: 'restricted' }, null)).toBe(false);
  });

  test('a read grant reaches for reads, not for claim/create', () => {
    const g = { teamId: TEAM, ...readGrant };
    expect(accountReachesWorkspace(g, restricted, null)).toBe(true);
    expect(accountReachesWorkspace(g, restricted, null, 'canClaim')).toBe(false);
  });

  test('a key or legacy token keeps the rule: restricted needs a link', () => {
    for (const a of [{ teamId: TEAM }, { teamId: TEAM, ...scopedKey }]) {
      expect(accountReachesWorkspace(a, restricted, null)).toBe(false);
      expect(accountReachesWorkspace(a, restricted, { canClaim: false, canCreate: true }, 'canCreate')).toBe(true);
      expect(accountReachesWorkspace(a, openSibling, null)).toBe(true);
    }
  });
});

describe('canAccessTokenRoute: a write grant (no scopes) is still workspace-confined', () => {
  const r = (path: string, method = 'GET') => ({ url: `https://x${path}`, method });

  test('names another workspace in path or query: refused; its own: allowed', () => {
    expect(canAccessTokenRoute(writeGrant, r(`/api/workspaces/${WS}/memory`))).toBe(true);
    expect(canAccessTokenRoute(writeGrant, r(`/api/workspaces/${OTHER}/memory`))).toBe(false);
    expect(canAccessTokenRoute(writeGrant, r(`/api/tasks?workspaceId=${OTHER}`))).toBe(false);
    expect(canAccessTokenRoute(writeGrant, r(`/api/tasks?workspaceId=${WS}`))).toBe(true);
    expect(canAccessTokenRoute(writeGrant, r('/api/tasks', 'POST'))).toBe(true);
  });

  test('team-wide collections and team administration: refused', () => {
    for (const [p, m] of [['/api/tasks', 'GET'], ['/api/artifacts', 'GET'], ['/api/secrets', 'GET'], ['/api/accounts', 'POST'], ['/api/model-tiers', 'GET'], [`/api/teams/${TEAM}`, 'GET'], ['/api/workspaces', 'POST']] as const) {
      expect(canAccessTokenRoute(writeGrant, r(p, m))).toBe(false);
    }
  });

  test('runner plumbing: refused to a grant, untouched for others', () => {
    for (const p of ['/api/runner/github-token', '/api/workers/heartbeat', '/api/knowledge/ingest-jobs/claim', '/api/quality-scout/runs/claim', '/api/webhooks/ingest', '/api/tasks/cleanup']) {
      expect(canAccessTokenRoute(writeGrant, r(p, 'POST'))).toBe(false);
      expect(canAccessTokenRoute(legacy, r(p, 'POST'))).toBe(true);
    }
    // Reading a Scout run's command log is read_evidence, not runner plumbing.
    expect(canAccessTokenRoute(readGrant, r(`/api/quality-scout/runs/${OTHER}/evidence?workspaceId=${WS}`))).toBe(true);
  });

  test('a grant with no workspace list reaches no route', () => {
    expect(canAccessTokenRoute({ oauthGrantId: 'g', workspaceIds: null, scopes: null }, r(`/api/tasks?workspaceId=${WS}`))).toBe(false);
  });

  test('legacy tokens and unscoped keys are unchanged', () => {
    expect(canAccessTokenRoute(legacy, r('/api/secrets'))).toBe(true);
    expect(canAccessTokenRoute({ workspaceIds: [WS], scopes: null }, r(`/api/tasks?workspaceId=${OTHER}`))).toBe(true);
  });
});

describe('every workspace check is judged on the session, not a bare account id', () => {
  // A grant session acts as its team's SHARED session account, so the id alone
  // judges that account (team-open workspaces), not the grant. Production code
  // must hand verifyAccountWorkspaceAccess the authenticated object.
  test('no production call passes `<account>.id`', () => {
    const root = join(import.meta.dir, '..', '..');
    const files = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(root, f), 'utf8');
      if (!src.includes('verifyAccountWorkspaceAccess(')) continue;
      for (const m of src.matchAll(/verifyAccountWorkspaceAccess\(\s*([^,)]+)/g)) {
        if (/\.id\s*$|\.accountId\s*$|^accountId!?$/.test(m[1].trim())) offenders.push(`${f}: ${m[1].trim()}`);
      }
    }
    // Callers no grant session can reach (chat runs on a signed-in session;
    // evidence backends are a team-admin surface a grant is refused).
    const allowed = new Set([
      'src/lib/ai/deps.ts: accountId',
      'src/lib/evidence-backend-access.ts: viewer.accountId',
    ]);
    expect(offenders.filter(o => !allowed.has(o))).toEqual([]);
  });
});
