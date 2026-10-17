import { describe, it, expect } from 'bun:test';
import { buildAgentAccessReport, reasonText, summarizeAccess, type CapabilityRow } from './access-log';

const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const row = (min: number, o: Partial<CapabilityRow>): CapabilityRow => ({
  occurredAt: new Date(T0 + min * 60_000), workspaceId: 'ws-1', workerId: 'w-1',
  capability: 'github.repo_grant', decision: 'allowed', resource: 'github_repo:row-1',
  reasonCode: null, expiresAt: null, sideEffect: null, ...o,
});
const REPOS = new Map([['row-1', 'acme/widget']]);

describe('summarizeAccess', () => {
  it('folds hourly renewals of the same grant into one item with a count', () => {
    const items = summarizeAccess([row(0, {}), row(55, {}), row(110, { expiresAt: new Date(T0 + 170 * 60_000) })], REPOS);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: 'GitHub repo access', target: 'acme/widget', count: 3, decision: 'allowed' });
    expect(items[0]!.expiresAt).toBe(new Date(T0 + 170 * 60_000).toISOString());
  });

  it('never folds refusals, and gives each a plain reason', () => {
    const items = summarizeAccess([
      row(1, { capability: 'pr.merge', decision: 'refused', resource: 'pr:7', reasonCode: 'pr_not_owned' }),
      row(2, { capability: 'pr.merge', decision: 'refused', resource: 'pr:7', reasonCode: 'pr_not_owned' }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ label: 'Merge PR', target: 'PR #7', reason: "not this task's PR" });
  });

  it('orders oldest first whatever order rows arrive in', () => {
    const items = summarizeAccess([row(5, { capability: 'pr.create', resource: 'pr:42' }), row(0, {})], REPOS);
    expect(items.map(i => i.label)).toEqual(['GitHub repo access', 'Open PR']);
  });

  it('labels token level, and never shows an internal repo id', () => {
    const items = summarizeAccess([
      row(0, { capability: 'task_token.mint', resource: null, reasonCode: 'admin_level' }),
      row(1, { resource: 'github_repo:unknown-row' }),
    ]);
    expect(items[0]).toMatchObject({ target: 'admin level', reason: 'admin level' });
    expect(items[1]!.target).toBe('linked repo');
    expect(JSON.stringify(items)).not.toContain('unknown-row');
  });
});

describe('reasonText', () => {
  it('turns an unknown code into words rather than showing it raw', () => {
    expect(reasonText('something_new_here')).toBe('something new here');
    expect(reasonText(null)).toBeNull();
  });
});

describe('buildAgentAccessReport', () => {
  const names = new Map([['ws-1', 'widget'], ['ws-2', 'docs']]);

  it('is healthy and quiet when every grant went through', () => {
    const r = buildAgentAccessReport([row(0, {}), row(1, { capability: 'task_token.mint', resource: null })], names, 24);
    expect(r).toMatchObject({ healthy: true, granted: 2, grantProblems: [], refusals: [] });
  });

  it('turns grant failures into per-workspace problems with their fix', () => {
    const r = buildAgentAccessReport([
      row(0, { decision: 'refused', reasonCode: 'installation_suspended', workspaceId: 'ws-2' }),
      row(5, { decision: 'refused', reasonCode: 'installation_suspended', workspaceId: 'ws-2' }),
    ], names, 24);
    expect(r.healthy).toBe(false);
    expect(r.grantProblems).toEqual([expect.objectContaining({ workspaceName: 'docs', count: 2, fix: expect.stringContaining('Unsuspend') })]);
  });

  it('counts agent refusals by action and reason, without calling them problems', () => {
    const r = buildAgentAccessReport([
      row(0, { capability: 'pr.merge', decision: 'refused', resource: 'pr:7', reasonCode: 'pr_not_owned' }),
      row(1, { capability: 'pr.merge', decision: 'refused', resource: 'pr:8', reasonCode: 'pr_not_owned' }),
      row(2, { capability: 'pr.create', decision: 'refused', reasonCode: 'protected_head' }),
    ], names, 24);
    expect(r.healthy).toBe(true);
    expect(r.refusals).toEqual([
      { label: 'Merge PR', reason: "not this task's PR", count: 2 },
      { label: 'Open PR', reason: 'a protected branch', count: 1 },
    ]);
  });

  it('counts admin-level grants', () => {
    const r = buildAgentAccessReport([row(0, { capability: 'task_token.mint', resource: null, reasonCode: 'admin_level' })], names, 24);
    expect(r.adminGranted).toBe(1);
  });
});
