import { describe, it, expect, beforeEach, mock } from 'bun:test';

// The lib imports db/schema/drizzle at module load; stub them so the pure functions
// (classifyMigration, sign/verifyDryRunToken) can be tested without a database.
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@buildd/core/db/schema', () => ({}));
mock.module('drizzle-orm', () => ({
  eq: () => ({}), and: () => ({}), isNull: () => ({}), isNotNull: () => ({}),
  inArray: () => ({}), sql: () => ({}),
}));

process.env.ENCRYPTION_KEY = 'test-encryption-key-for-hmac';

import {
  signDryRunToken, verifyDryRunToken, classifyMigration, type MigrationSnapshot,
} from './workspace-migration';

const NOW = 1_800_000_000_000;

function snap(overrides: Partial<MigrationSnapshot> = {}): MigrationSnapshot {
  return {
    workspace: { id: 'ws-1', name: 'Cue', teamId: 'team-src', githubInstallationId: null },
    sourceTeam: { id: 'team-src', name: 'Buildd' },
    destinationTeam: { id: 'team-dst', name: 'Cue Service' },
    counts: { tasks: 12, workers: 5, workersInFlight: 1, artifacts: 3, watchedProjects: 0, oauthTokens: 2, teamMissions: 4, teamRoles: 3 },
    schedules: [{ name: 'Daily scan', cronExpression: '0 9 * * *' }],
    workspaceMissions: [],
    workspaceRoles: [],
    destinationRoleSlugs: [],
    workspaceSecrets: [],
    connectors: [],
    accountAccess: [],
    githubInstallationValid: true,
    ...overrides,
  };
}

describe('dry-run token', () => {
  it('round-trips a freshly signed token', () => {
    const t = signDryRunToken('ws-1', 'team-dst', NOW);
    expect(verifyDryRunToken(t, 'ws-1', 'team-dst', NOW).valid).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const t = signDryRunToken('ws-1', 'team-dst', NOW);
    const tampered = t.slice(0, -2) + (t.endsWith('aa') ? 'bb' : 'aa');
    expect(verifyDryRunToken(tampered, 'ws-1', 'team-dst', NOW).valid).toBe(false);
  });

  it('rejects a token bound to a different workspace/destination', () => {
    const t = signDryRunToken('ws-1', 'team-dst', NOW);
    expect(verifyDryRunToken(t, 'ws-2', 'team-dst', NOW).reason).toBe('tampered');
    expect(verifyDryRunToken(t, 'ws-1', 'team-other', NOW).reason).toBe('tampered');
  });

  it('rejects a stale token (>5 min old)', () => {
    const t = signDryRunToken('ws-1', 'team-dst', NOW);
    expect(verifyDryRunToken(t, 'ws-1', 'team-dst', NOW + 5 * 60 * 1000 + 1).reason).toBe('stale');
  });

  it('rejects a token from the future beyond clock skew', () => {
    const t = signDryRunToken('ws-1', 'team-dst', NOW + 10 * 60 * 1000);
    expect(verifyDryRunToken(t, 'ws-1', 'team-dst', NOW).reason).toBe('future');
  });

  it('rejects a malformed token', () => {
    expect(verifyDryRunToken('garbage', 'ws-1', 'team-dst', NOW).reason).toBe('malformed');
  });
});

describe('classifyMigration', () => {
  const at = '2026-07-23T00:00:00.000Z';

  it('classifies a clean workspace with no acks required', () => {
    const r = classifyMigration(snap(), at);
    expect(r.precheck.status).toBe('PASS');
    expect(r.requiredAcks).toEqual([]);
    expect(r.summary.NEEDS_RE_ENTRY).toBe(0);
    expect(r.summary.NEEDS_RE_AUTH).toBe(0);
    expect(r.summary.WILL_BREAK).toBe(0);
    expect(r.groups.find((g) => g.entity === 'Tasks')?.count).toBe(12);
  });

  it('flags workspace-scoped secrets as NEEDS_RE_ENTRY and requires their ack', () => {
    const r = classifyMigration(snap({
      workspaceSecrets: [
        { purpose: 'mcp_credential', label: 'GITHUB_TOKEN' },
        { purpose: 'vercel_token', label: 'VERCEL_PROD' },
      ],
    }), at);
    expect(r.summary.NEEDS_RE_ENTRY).toBe(2);
    expect(r.requiredAcks).toContain('secret:mcp_credential:GITHUB_TOKEN');
    expect(r.requiredAcks).toContain('secret:vercel_token:VERCEL_PROD');
  });

  it('flags connectors as NEEDS_RE_AUTH with names', () => {
    const r = classifyMigration(snap({
      connectors: [{ id: 'c1', name: 'Linear', authMode: 'oauth' }],
    }), at);
    expect(r.summary.NEEDS_RE_AUTH).toBe(1);
    expect(r.requiredAcks).toContain('connector:c1');
    expect(r.groups.find((g) => g.entity === 'Connectors')?.items?.[0].label).toContain('Linear');
  });

  it('flags account access as WILL_BREAK', () => {
    const r = classifyMigration(snap({
      accountAccess: [{ accountId: 'a1', name: 'runner-prod' }],
    }), at);
    expect(r.requiredAcks).toContain('account:a1');
    expect(r.summary.WILL_BREAK).toBe(1);
  });

  it('flags a canDelegateTo target missing in the destination team as WILL_BREAK', () => {
    const r = classifyMigration(snap({
      workspaceRoles: [{ slug: 'builder', name: 'Builder', canDelegateTo: ['researcher', 'qa-role'] }],
      destinationRoleSlugs: [],
    }), at);
    // 'researcher' is a default role → not broken; 'qa-role' is → broken.
    expect(r.requiredAcks).toContain('delegation:builder->qa-role');
    expect(r.requiredAcks).not.toContain('delegation:builder->researcher');
  });

  it('flags a dependsOnMission target that stays behind as WILL_BREAK', () => {
    const r = classifyMigration(snap({
      workspaceMissions: [
        { id: 'm1', title: 'Sprint 12', status: 'active', dependsOnMissionId: 'team-roadmap' },
        { id: 'm2', title: 'Sprint 13', status: 'active', dependsOnMissionId: 'm1' },
      ],
    }), at);
    // m1 depends on a non-moving mission → break; m2 depends on m1 (moving) → fine.
    expect(r.requiredAcks).toContain('mission-dep:m1');
    expect(r.requiredAcks).not.toContain('mission-dep:m2');
  });

  it('PRECHECK FAIL when the workspace GitHub installation is missing/suspended', () => {
    const r = classifyMigration(snap({
      workspace: { id: 'ws-1', name: 'Cue', teamId: 'team-src', githubInstallationId: 'inst-1' },
      githubInstallationValid: false,
    }), at);
    expect(r.precheck.status).toBe('FAIL');
    expect(r.precheck.githubApp.ok).toBe(false);
  });

  it('PRECHECK PASS for a repo-backed workspace when its installation is valid (team-agnostic)', () => {
    const r = classifyMigration(snap({
      workspace: { id: 'ws-1', name: 'Cue', teamId: 'team-src', githubInstallationId: 'inst-1' },
      githubInstallationValid: true,
    }), at);
    expect(r.precheck.status).toBe('PASS');
  });

  it('PRECHECK PASS for a repo-less workspace regardless of GitHub state', () => {
    const r = classifyMigration(snap({ githubInstallationValid: true }), at);
    expect(r.precheck.status).toBe('PASS');
  });
});
