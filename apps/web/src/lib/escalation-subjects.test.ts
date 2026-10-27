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

  it('review_exhausted carries the projection headline, so approved-then-refused is not "never approved"', () => {
    const k = (headline: string) => ({ stateReason: 'review_exhausted', prState: 'ci_passed', detail: null, headline });
    expect(prSubjectFor(input({ kernel: k('Approved twice, then a later change was refused') }))).toMatchObject({ reviewHistory: 'Approved twice, then a later change was refused' });
    expect(prSubjectFor(input({ kernel: k('Review budget spent without an approval') }))).toMatchObject({ reviewHistory: 'Review budget spent without an approval' });
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

describe('prSubjectFor: stale CI reading on a moved head', () => {
  const NOW = Date.parse('2026-10-27T12:00:00Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  // The real inputs for a head that moved: the kernel reads awaiting_ci (no fact on the new head), no lifecycle.
  const moved = (stateSince: string, over: Partial<PrSubjectInput> = {}) => input({
    lifecycle: null, nowMs: NOW, escalated: { reason: 'The fix does not handle the empty list case' },
    kernel: { stateReason: 'review_escalated', prState: 'awaiting_ci', detail: null, headline: null, stateSince },
    ...over,
  });

  it('ESCALATED + head moved + no reading for over an hour is paged, not held as wait_ci', () => {
    const s = prSubjectFor(moved(ago(2 * 60 * 60_000), { kernel: { stateReason: 'needs_you', prState: 'awaiting_ci', detail: null, headline: null, stateSince: ago(2 * 60 * 60_000) } }));
    expect(s.ciReadingStale).toBe(true);
    expect(escalationRule(s)).toMatchObject({ owner: 'person', rail: 'no_next_step' });
    // A reviewer escalation is no longer held either: it goes to Jev (null verdict), not wait_ci.
    expect(escalationRule(prSubjectFor(moved(ago(2 * 60 * 60_000))))).toBeNull();
  });

  it('a fresh awaiting_ci still waits for the checks', () => {
    const s = prSubjectFor(moved(ago(5 * 60_000)));
    expect(s.ciReadingStale).toBe(false);
    expect(escalationRule(s)).toMatchObject({ owner: 'buildd', action: 'wait_ci' });
  });

  it('a conflict fixes already spent, head moved, stale readings: paged', () => {
    const s = prSubjectFor(moved(ago(3 * 60 * 60_000), { conflictFixesSpent: true }));
    expect(s.why).toBe('conflict_fixes_spent');
    expect(s.conflict).toBe(false);
    expect(escalationRule(s)).toMatchObject({ owner: 'person' });
  });

  it('a conflict resolved on the new head is not reported as a conflict', () => {
    const s = prSubjectFor(moved(ago(3 * 60 * 60_000), { conflictFixesSpent: true, kernel: { stateReason: null, prState: 'ci_passed', detail: null, headline: null, stateSince: ago(3 * 60 * 60_000) } }));
    expect(s.conflict).toBe(false);
  });

  it('a dirty reading on the current head is still a conflict_fix', () => {
    const s = prSubjectFor(moved(ago(3 * 60 * 60_000), { kernel: { stateReason: 'review_escalated', prState: 'conflict', detail: null, headline: null, stateSince: ago(3 * 60 * 60_000) } }));
    expect(escalationRule(s)).toMatchObject({ action: 'conflict_fix' });
  });

  it('a red CI reading is never stale-skipped', () => {
    const s = prSubjectFor(moved(ago(3 * 60 * 60_000), { kernel: { stateReason: null, prState: 'ci_failed', detail: null, headline: null, stateSince: ago(3 * 60 * 60_000) } }));
    expect(escalationRule(s)).toMatchObject({ action: 'ci_fix' });
  });
});

describe('prSubjectFor: data migrations', () => {
  it('carries the workspace setting to the gate', () => {
    expect(prSubjectFor(input({ agentReviewsDataMigrations: true })).agentReviewsDataMigrations).toBe(true);
    expect(prSubjectFor(input()).agentReviewsDataMigrations).toBeFalsy();
  });
});
