import { describe, expect, it } from 'bun:test';
import type { HealthItem } from '@/lib/workspace-health';
import { readinessNotices } from './readiness-notices';

const OK = { ok: true, repo: 'acme/web', remediation: null, waitingTasks: 0 };
const broken = (reason: string) => ({
  ok: false,
  repo: 'acme/web',
  waitingTasks: 0,
  remediation: { reason, title: 'Connection required', message: '', action: { kind: 'operator', label: '', url: null }, adminInstructions: null, githubUrl: null },
}) as any;

const POLICY: HealthItem = { id: 'policy', severity: 'warning', label: 'Merge policy has not been reviewed', action: { kind: 'review-policy', label: 'Review' } };

const admin = (over: Partial<Parameters<typeof readinessNotices>[0]> = {}) =>
  readinessNotices({ canManage: true, repoAccessView: OK, healthItems: [POLICY], ...over });

describe('readinessNotices', () => {
  it('healthy repo: admins get the scan and the access row', () => {
    expect(admin()).toEqual({ health: [POLICY], readiness: true, repoAccess: true });
  });

  it('GitHub App not configured: one notice (access), no failing repo scan', () => {
    const n = admin({ repoAccessView: broken('app_not_configured') });
    expect(n.readiness).toBe(false);
    expect(n.repoAccess).toBe(true);
  });

  it.each(['installation_missing', 'installation_suspended', 'repo_not_selected', 'workspace_not_linked', 'permission_missing'])(
    'access broken (%s): the access card speaks alone',
    (reason) => {
      const n = admin({ repoAccessView: broken(reason) });
      expect([n.readiness, n.repoAccess]).toEqual([false, true]);
    },
  );

  it('no repo linked: admins get the inline picker only; members get the access notice', () => {
    const a = admin({ repoAccessView: broken('no_repo') });
    expect([a.readiness, a.repoAccess]).toEqual([true, false]);
    const m = readinessNotices({ canManage: false, repoAccessView: broken('no_repo'), healthItems: [] });
    expect([m.readiness, m.repoAccess]).toEqual([false, true]);
  });

  it('access view unavailable: the scan still renders', () => {
    expect(admin({ repoAccessView: null })).toEqual({ health: [POLICY], readiness: true, repoAccess: false });
  });

  it('members never see health or the scan, and see access only when broken', () => {
    const m = readinessNotices({ canManage: false, repoAccessView: OK, healthItems: [POLICY] });
    expect(m).toEqual({ health: [], readiness: false, repoAccess: false });
  });
});
