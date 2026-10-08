import { describe, expect, it } from 'bun:test';
import type { ScoutRun } from '@buildd/core/quality-scout/types';
import {
  authorizeScoutCaptureGrant,
  SCOUT_CAPTURE_TOKEN_PERMISSIONS,
  scoutCaptureGrantMinter,
  type ScoutCaptureGrantDeps,
  type ScoutCaptureWorkspace,
} from './quality-scout-capture-grant';

const REPO = 'acme/web';
const ROW = 'row-1';

function ws(over: Partial<ScoutCaptureWorkspace> = {}, installation: Partial<NonNullable<NonNullable<ScoutCaptureWorkspace['githubRepo']>['installation']>> = {}): ScoutCaptureWorkspace {
  return {
    id: 'ws-1',
    gitConfig: {},
    githubRepoId: ROW,
    githubRepo: {
      id: ROW, repoId: 42, owner: 'acme', name: 'web', fullName: REPO,
      installation: { installationId: 7, suspendedAt: null, permissions: { actions: 'write', contents: 'write', pull_requests: 'write', metadata: 'read' }, ...installation },
    },
    ...over,
  };
}

describe('authorizeScoutCaptureGrant', () => {
  it('asks for Actions write and metadata read on the one linked repo, nothing else the installation has', () => {
    const d = authorizeScoutCaptureGrant(ws(), REPO);
    expect(d).toEqual({ allowed: true, repo: { repoId: 42, fullName: REPO, rowId: ROW }, installationId: 7, permissions: { actions: 'write', metadata: 'read' } });
    expect(SCOUT_CAPTURE_TOKEN_PERMISSIONS).toEqual({ actions: 'write', metadata: 'read' });
  });

  it('refuses a preview page source: browser capture is a later slice', () => {
    expect(authorizeScoutCaptureGrant(ws({ gitConfig: { visualQa: { pageSource: 'vercel-preview' } } }), REPO)).toEqual({ allowed: false, reason: 'page_source_not_sandbox' });
    expect(authorizeScoutCaptureGrant(ws({ gitConfig: { visualQa: { pageSource: 'auto' } } }), REPO)).toEqual({ allowed: false, reason: 'page_source_not_sandbox' });
  });

  it('refuses with no linked repo, a mismatched link, or a repo other than the claimed one', () => {
    expect(authorizeScoutCaptureGrant(ws({ githubRepoId: null }), REPO)).toEqual({ allowed: false, reason: 'no_linked_repo' });
    expect(authorizeScoutCaptureGrant(ws({ githubRepoId: 'row-2' }), REPO)).toEqual({ allowed: false, reason: 'no_linked_repo' });
    expect(authorizeScoutCaptureGrant(ws(), 'acme/other')).toEqual({ allowed: false, reason: 'no_linked_repo' });
  });

  it('refuses a suspended installation', () => {
    expect(authorizeScoutCaptureGrant(ws({}, { suspendedAt: new Date() }), REPO)).toEqual({ allowed: false, reason: 'installation_suspended' });
  });

  it('refuses when the installed permissions are unknown (an unnarrowed token would inherit them all) or lack Actions write', () => {
    expect(authorizeScoutCaptureGrant(ws({}, { permissions: null }), REPO)).toEqual({ allowed: false, reason: 'permissions_unavailable' });
    expect(authorizeScoutCaptureGrant(ws({}, { permissions: {} }), REPO)).toEqual({ allowed: false, reason: 'permissions_unavailable' });
    expect(authorizeScoutCaptureGrant(ws({}, { permissions: { actions: 'read', metadata: 'read' } }), REPO)).toEqual({ allowed: false, reason: 'permissions_unavailable' });
  });
});

describe('scoutCaptureGrantMinter', () => {
  const run = { id: 'run-1', workspaceId: 'ws-1' } as ScoutRun;
  const lease = new Date('2026-10-07T12:25:00Z');

  function deps(over: Partial<ScoutCaptureGrantDeps> = {}) {
    const records: Array<Record<string, unknown>> = [];
    const loads: Array<[string, string]> = [];
    const mints: Array<Record<string, unknown>> = [];
    const d: ScoutCaptureGrantDeps = {
      loadWorkspace: async (id, team) => { loads.push([id, team]); return ws(); },
      mint: async (q) => { mints.push(q); return { token: 'ghs_minted_token_value', expiresAt: new Date('2026-10-07T13:00:00Z') }; },
      record: (async (r: Record<string, unknown>) => { records.push(r); }) as never,
      ...over,
    };
    return { d, records, loads, mints };
  }

  it('loads the workspace inside the caller\'s team, mints with the narrowed set and audits without the token', async () => {
    const t = deps();
    const out = await scoutCaptureGrantMinter({ accountId: 'acct-1', teamId: 'team-a' }, t.d)({ run, repo: REPO, leaseExpiresAt: lease });
    expect(out).toEqual({ ok: true, grant: { token: 'ghs_minted_token_value', expiresAt: '2026-10-07T13:00:00.000Z', repository: REPO, pageSource: 'sandbox' } });
    expect(t.loads).toEqual([['ws-1', 'team-a']]);
    expect(t.mints).toEqual([{ installationId: 7, repoId: 42, permissions: { actions: 'write', metadata: 'read' } }]);
    expect(t.records).toHaveLength(1);
    expect(t.records[0]).toMatchObject({ capability: 'github.scout_capture_grant', decision: 'allowed', principalVia: 'runner_key', resource: `github_repo:${ROW}` });
    expect(JSON.stringify(t.records)).not.toContain('ghs_minted_token_value');
  });

  it('another team\'s workspace (not found in the caller\'s team) gets no token', async () => {
    const t = deps({ loadWorkspace: async () => null });
    expect(await scoutCaptureGrantMinter({ accountId: 'a', teamId: 'team-b' }, t.d)({ run, repo: REPO, leaseExpiresAt: lease })).toEqual({ ok: false, reason: 'no_linked_repo' });
    expect(t.mints).toEqual([]);
    expect(t.records[0]).toMatchObject({ decision: 'refused', reasonCode: 'no_linked_repo' });
  });

  it('a GitHub refusal is mint_failed, audited, and never throws', async () => {
    const t = deps({ mint: async () => { throw new Error('HTTP 422'); } });
    expect(await scoutCaptureGrantMinter({ accountId: 'a', teamId: 'team-a' }, t.d)({ run, repo: REPO, leaseExpiresAt: lease })).toEqual({ ok: false, reason: 'mint_failed' });
    expect(t.records[0]).toMatchObject({ decision: 'refused', reasonCode: 'mint_failed' });
  });
});
