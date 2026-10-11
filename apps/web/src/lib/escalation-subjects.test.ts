import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { escalationRule } from '@buildd/core/escalation-gate';
import { ciStateOf, landingStallOf, landingStallWhere, prSubjectFor, type PrSubjectInput } from './escalation-subjects';

const input = (over: Partial<PrSubjectInput> = {}): PrSubjectInput => ({
  teamId: 'team', sensitive: false, workspaceId: 'ws', prNumber: 9, taskId: 'task-9',
  task: { title: 'fix(a): b', missionId: null }, missionPrRole: null, lifecycle: 'ci_green',
  escalated: null, approved: false, handoff: null, conflictFixesSpent: false, machineActing: false, landingStall: null,
  ...over,
});

describe('landingStallOf', () => {
  it('reads a migration collision and a stranded landing from the last pr_landing look', () => {
    expect(landingStallOf({ outcome: 'deferred', reason: 'migration number collision: <n>_a.sql conflicts with open PR #<n>' })).toBe('migration_collision');
    expect(landingStallOf({ outcome: 'stranded', reason: 'the base kept moving after <n> refreshes' })).toBe('stranded');
    expect(landingStallOf({ outcome: 'deferred', reason: 'a branch refresh is queued' })).toBeNull();
    expect(landingStallOf(null)).toBeNull();
  });

  it('reads only this gate, these tasks, inside the window', () => {
    const q = new PgDialect().sqlToQuery(landingStallWhere(['t1'], new Date('2026-10-08T00:00:00Z')) as any);
    expect(q.sql).toContain('"task_id" in ($1)');
    expect(q.sql).toContain('"gate" = $2');
    expect(q.sql).toContain('"occurred_at" >= $3');
    expect(q.params.slice(0, 2)).toEqual(['t1', 'pr_landing']);
  });
});

describe('ciStateOf', () => {
  it('prefers the kernel\'s PR state over a stale lifecycle column', () => {
    expect(ciStateOf('ci_green', 'ci_failed')).toBe('red');
    expect(ciStateOf('ci_failed', 'ci_passed')).toBe('green');
    expect(ciStateOf('ci_running')).toBe('running');
    expect(ciStateOf('pr_open')).toBe('unknown');
    expect(ciStateOf(null)).toBe('unknown');
  });
});

describe('prSubjectFor: policy-merge inputs', () => {
  it('reads risk classes from the task paths, policy-only from the escalation words, XL from the diff', () => {
    const s = prSubjectFor(input({
      pathManifest: ['packages/core/db/schema.ts', 'packages/core/drizzle/'], escalated: { reason: 'Hard rule: schema changes require human review' },
      linesChanged: 1200, draft: false, headSha: 'h', reviewedHeadSha: 'h',
    }));
    expect(s.riskClasses).toContain('destructive_schema_change');
    expect(s).toMatchObject({ policyOnly: true, sizeXl: true, headIsCurrent: true, draft: false });
  });

  it('a reviewer\'s own judgment is not policy only', () => {
    expect(prSubjectFor(input({ escalated: { reason: 'The fix does not handle the empty list case' } })).policyOnly).toBe(false);
  });
});

describe('prSubjectFor', () => {
  it('keys a PR by workspace and number', () => {
    expect(prSubjectFor(input()).key).toBe('pr:ws:9');
  });

  it('a landing handoff for a protected path is the person\'s', () => {
    const s = prSubjectFor(input({ handoff: { cause: 'deny_path', reason: 'touches a protected path' } }));
    expect(s.why).toBe('landing_handoff');
    expect(escalationRule(s)).toMatchObject({ owner: 'person', rail: 'protected_path' });
  });

  it('a mission ship PR the reviewer escalated is the person\'s', () => {
    const s = prSubjectFor(input({ task: { title: 'Ship mission: Widgets', missionId: 'm' }, missionPrRole: 'ship', escalated: { reason: 'scope' }, lifecycle: 'ci_running' }));
    expect(s.missionPrRole).toBe('ship');
    expect(escalationRule(s)).toMatchObject({ owner: 'person', rail: 'mission_ship_escalation' });
  });

  it('a kernel escalation reads its reason from the delivery', () => {
    const s = prSubjectFor(input({ kernel: { stateReason: 'review_exhausted', prState: 'ci_passed', detail: 'rounds spent', headline: 'Needs a decision' } }));
    expect(s).toMatchObject({ why: 'review_exhausted', ci: 'green', detail: 'rounds spent' });
  });

  it('a migration collision and a stranded landing become Buildd\'s next steps', () => {
    expect(escalationRule(prSubjectFor(input({ landingStall: 'migration_collision', lifecycle: 'pr_open' })))).toMatchObject({ action: 'renumber_migration' });
    expect(escalationRule(prSubjectFor(input({ landingStall: 'stranded', lifecycle: 'ci_green' })))).toMatchObject({ action: 'retry_landing' });
  });

  it('conflict fixes used up and a live conflict are told apart', () => {
    expect(prSubjectFor(input({ lifecycle: 'conflict', conflictFixesSpent: true })).why).toBe('conflict_fixes_spent');
    expect(escalationRule(prSubjectFor(input({ lifecycle: 'conflict' })))).toMatchObject({ action: 'conflict_fix' });
  });
});

describe('prSubjectFor: data migrations', () => {
  it('carries the workspace setting to the gate', () => {
    expect(prSubjectFor(input({ agentReviewsDataMigrations: true })).agentReviewsDataMigrations).toBe(true);
    expect(prSubjectFor(input()).agentReviewsDataMigrations).toBeFalsy();
  });
});
