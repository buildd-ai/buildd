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

describe('summarizeAccess source', () => {
  const r = (capability: string, o: Partial<CapabilityRow> = {}): CapabilityRow => ({
    occurredAt: new Date(T0), workspaceId: 'ws', workerId: 'w', capability, decision: 'allowed',
    resource: null, reasonCode: null, expiresAt: null, sideEffect: null, ...o,
  });
  it('treats the buildd token and repo access as run credentials, not governed grants', () => {
    const items = summarizeAccess([r('task_token.mint'), r('github.repo_grant'), r('capability.use', { resource: 'grant:g1' })]);
    expect(items.map(i => i.source)).toEqual(['run', 'run', 'grant']);
    expect(items[2].grantId).toBe('g1');
  });
  it('marks a request pending until a later row decides its grant', () => {
    const req = r('capability.request', { decision: 'refused', resource: 'grant:g1', reasonCode: 'pending_approval:needs_person' });
    expect(summarizeAccess([req])[0].pending).toBe(true);
    const approve = r('capability.approve', { resource: 'grant:g1', occurredAt: new Date(T0 + 60_000) });
    expect(summarizeAccess([req, approve])[0].pending).toBe(false);
  });

  describe('a request is waiting only while it is open on a live run', () => {
    const req = r('capability.request', { decision: 'refused', resource: 'grant:g1', reasonCode: 'pending_approval:needs_person' });
    const run = (taskStatus: string | null, status: string, workerStatus: string | null) =>
      ({ taskStatus, requests: new Map([['g1', { status, workerStatus }]]) });

    it('pending on a live task and run: waiting', () => {
      const [i] = summarizeAccess([req], new Map(), run('in_progress', 'pending', 'running'));
      expect(i).toMatchObject({ pending: true, closed: null });
    });
    it('closed because the task ended: not waiting, says why', () => {
      const [i] = summarizeAccess([req], new Map(), run('completed', 'expired', 'completed'));
      expect(i).toMatchObject({ pending: false, closed: 'the task ended' });
    });
    it('row still pending but the task is terminal: closed (fails closed)', () => {
      const [i] = summarizeAccess([req], new Map(), run('failed', 'pending', 'running'));
      expect(i).toMatchObject({ pending: false, closed: 'the task ended' });
    });
    it('row still pending but its agent run stopped: closed', () => {
      const [i] = summarizeAccess([req], new Map(), run('in_progress', 'pending', 'failed'));
      expect(i).toMatchObject({ pending: false, closed: 'the agent run stopped' });
    });
    it('no grant row found: closed, never waiting', () => {
      const [i] = summarizeAccess([req], new Map(), { taskStatus: 'in_progress', requests: new Map() });
      expect(i.pending).toBe(false);
      expect(i.closed).not.toBeNull();
    });
  });
});

describe('summarizeAccess database.query', () => {
  it('every query is its own item with its SQL, row count and duration; refusals too', () => {
    const q = (min: number, o: Partial<CapabilityRow>) => row(min, { capability: 'database.query', resource: 'grant:g-1', ...o });
    const items = summarizeAccess([
      q(0, { sideEffect: { sql: 'select id from tasks', sqlTruncated: false, rowCount: 3, durationMs: 12, truncated: false } }),
      q(1, { sideEffect: { sql: 'select id from missions', sqlTruncated: false, rowCount: 200, durationMs: 40, truncated: true } }),
      q(2, { decision: 'refused', reasonCode: 'table_not_allowed', sideEffect: { sql: 'select * from secrets', sqlTruncated: false, rowCount: null, durationMs: null } }),
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ label: 'Database query', source: 'grant', target: 'production database (read-only)', query: { sql: 'select id from tasks', rowCount: 3, durationMs: 12, truncated: false } });
    expect(items[1]!.query).toMatchObject({ sql: 'select id from missions', truncated: true });
    expect(items[2]).toMatchObject({ decision: 'refused', reason: 'a table outside the read allowlist', query: { sql: 'select * from secrets', rowCount: null } });
  });

  it('other rows carry no query field', () => {
    expect(summarizeAccess([row(0, {})])[0]).not.toHaveProperty('query');
  });
});
