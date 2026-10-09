import { describe, expect, it } from 'bun:test';
import {
  escalationFingerprint,
  escalationRule,
  resolveEscalationAnswer,
  verdictAt,
  type EscalationSubject,
} from '../escalation-gate';

const base = (over: Partial<EscalationSubject>): EscalationSubject => ({
  key: 'pr:ws:1',
  workspaceId: 'ws',
  prNumber: 1,
  taskId: 't',
  missionId: null,
  title: 'fix(x): something',
  why: 'human_tier',
  ci: 'green',
  conflict: false,
  machineActing: false,
  missionPrRole: null,
  ...over,
});

/**
 * The ten shapes the owner was paged for on one day (mission 9c079a70). Only
 * the protected-path, data-migration and reviewer-escalated mission-ship shapes
 * are a person's; every other one has a named machine owner.
 */
const SHAPES: Array<{ name: string; subject: EscalationSubject; owner: 'person' | 'buildd'; action?: string; rail?: string }> = [
  {
    name: 'red CI the kernel did not retry',
    subject: base({ why: 'human_tier', ci: 'red', detail: 'Reviewer requested changes 3 times; automated fix attempts exhausted' }),
    owner: 'buildd', action: 'ci_fix',
  },
  {
    name: 'approved, landing stranded by a moving base',
    subject: base({ why: 'human_tier', ci: 'running', landingStranded: true }),
    owner: 'buildd', action: 'retry_landing',
  },
  {
    name: 'mission refresh PR held on a migration number collision, reviewer escalated',
    subject: base({ why: 'reviewer_escalated', ci: 'running', missionPrRole: 'refresh', migrationCollision: true }),
    owner: 'buildd', action: 'renumber_migration',
  },
  {
    name: 'mission refresh PR held on a migration number collision',
    subject: base({ why: 'human_tier', ci: 'unknown', missionPrRole: 'refresh', migrationCollision: true }),
    owner: 'buildd', action: 'renumber_migration',
  },
  {
    name: 'approved but CI not green',
    subject: base({ why: 'approved_needs_merge', ci: 'running' }),
    owner: 'buildd', action: 'wait_ci',
  },
  {
    name: 'human merge, CI not green (friction fix)',
    subject: base({ why: 'human_tier', ci: 'unknown' }),
    owner: 'buildd', action: 'wait_ci',
  },
  {
    name: 'human merge, CI not green (security-tagged review)',
    subject: base({ why: 'reviewer_escalated', ci: 'running', detail: 'Decide whether to drop an unverified branch; security scope' }),
    owner: 'buildd', action: 'wait_ci',
  },
  {
    name: 'protected path: a workflow file',
    subject: base({ why: 'landing_handoff', ci: 'green', handoffCause: 'deny_path', handoffReason: 'touches .github/workflows/' }),
    owner: 'person', rail: 'protected_path',
  },
  {
    name: 'data migration UPDATE',
    subject: base({ why: 'landing_handoff', ci: 'green', handoffCause: 'migration_review', handoffReason: 'runs data migration UPDATE on tasks' }),
    owner: 'person', rail: 'data_migration',
  },
  {
    name: 'reviewer-escalated mission ship',
    subject: base({ why: 'reviewer_escalated', ci: 'running', missionPrRole: 'ship', title: 'Ship mission: Something' }),
    owner: 'person', rail: 'mission_ship_escalation',
  },
];

describe('escalationRule: the ten shapes', () => {
  for (const s of SHAPES) {
    it(s.name, () => {
      const v = escalationRule(s.subject);
      expect(v).not.toBeNull();
      expect(v!.owner).toBe(s.owner);
      expect(v!.by).toBe('rule');
      if (s.action) expect(v!.owner === 'buildd' && v!.action).toBe(s.action as never);
      if (s.rail) expect(v!.owner === 'person' && v!.rail).toBe(s.rail as never);
      expect(v!.reason.length).toBeGreaterThan(0);
    });
  }

  it('exactly three of the ten are a person\'s', () => {
    expect(SHAPES.filter(s => escalationRule(s.subject)?.owner === 'person')).toHaveLength(3);
  });
});

describe('escalationRule: ordering', () => {
  it('Buildd acting wins over everything, rails included', () => {
    const v = escalationRule(base({ machineActing: true, why: 'landing_handoff', handoffCause: 'deny_path' }));
    expect(v).toMatchObject({ owner: 'buildd', action: 'wait_machine' });
  });

  it('a protected path with red CI is fixed first, then asked', () => {
    expect(escalationRule(base({ ci: 'red', why: 'landing_handoff', handoffCause: 'deny_path' }))).toMatchObject({ owner: 'buildd', action: 'ci_fix' });
  });

  it('a conflict with fixes left gets a conflict fix', () => {
    expect(escalationRule(base({ conflict: true }))).toMatchObject({ owner: 'buildd', action: 'conflict_fix' });
  });

  it('a handoff for a refresh that gave up is a landing retry', () => {
    expect(escalationRule(base({ why: 'landing_handoff', ci: 'green', handoffCause: 'refresh_exhausted' }))).toMatchObject({ owner: 'buildd', action: 'retry_landing' });
  });

  it('conflict fixes used up is not a rule: Jev decides', () => {
    expect(escalationRule(base({ conflict: true, why: 'conflict_fixes_spent' }))).toBeNull();
  });

  it('a reviewer escalation on a green, ordinary PR is Jev\'s', () => {
    expect(escalationRule(base({ why: 'reviewer_escalated', ci: 'green' }))).toBeNull();
  });

  it('an irreversible action named in the escalation goes to a person', () => {
    expect(escalationRule(base({ why: 'reviewer_escalated', detail: 'Landing it needs a force push to the base branch' }))).toMatchObject({ owner: 'person', rail: 'irreversible' });
  });
});

describe('escalationFingerprint', () => {
  it('is stable for the same state and changes with it', () => {
    const a = base({});
    expect(escalationFingerprint(a)).toBe(escalationFingerprint({ ...a }));
    expect(escalationFingerprint(a)).not.toBe(escalationFingerprint({ ...a, ci: 'red' }));
    expect(escalationFingerprint(a)).not.toBe(escalationFingerprint({ ...a, headSha: 'abc' }));
  });

  it('ignores the title wording', () => {
    const a = base({});
    expect(escalationFingerprint(a)).toBe(escalationFingerprint({ ...a, title: 'other words' }));
  });
});

describe('resolveEscalationAnswer', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');

  it('a confident act names the action', () => {
    const v = resolveEscalationAnswer({ disposition: 'act', dispositionConfidence: 0.9, action: 'address_review', actionConfidence: 0.8 }, 0.7, now);
    expect(v).toMatchObject({ owner: 'buildd', by: 'jev', action: 'address_review' });
  });

  it('a hold carries its deadline', () => {
    const v = resolveEscalationAnswer({ disposition: 'hold', dispositionConfidence: 0.9, action: null, actionConfidence: null }, 0.7, now);
    expect(v).toMatchObject({ owner: 'buildd', by: 'jev', action: 'hold' });
    expect(v.owner === 'buildd' && Date.parse(v.holdUntil!)).toBeGreaterThan(now);
  });

  it('ask goes to the person with a reason', () => {
    const v = resolveEscalationAnswer({ disposition: 'ask', dispositionConfidence: 0.9, action: null, actionConfidence: null }, 0.7, now);
    expect(v).toMatchObject({ owner: 'person', by: 'jev' });
  });

  it('low confidence, or act without a confident action, falls back to the person', () => {
    expect(resolveEscalationAnswer({ disposition: 'act', dispositionConfidence: 0.5, action: 're_review', actionConfidence: 0.9 }, 0.7, now)).toMatchObject({ owner: 'person', by: 'fallback' });
    expect(resolveEscalationAnswer({ disposition: 'act', dispositionConfidence: 0.9, action: null, actionConfidence: null }, 0.7, now)).toMatchObject({ owner: 'person', by: 'fallback' });
    expect(resolveEscalationAnswer({ disposition: 'act', dispositionConfidence: 0.9, action: 're_review', actionConfidence: 0.4 }, 0.7, now)).toMatchObject({ owner: 'person', by: 'fallback' });
  });
});

describe('verdictAt', () => {
  it('an expired hold is the person\'s again', () => {
    const v = { owner: 'buildd' as const, by: 'jev' as const, action: 'hold' as const, reason: 'r', holdUntil: '2026-10-09T12:00:00Z' };
    expect(verdictAt(v, Date.parse('2026-10-09T11:00:00Z')).owner).toBe('buildd');
    expect(verdictAt(v, Date.parse('2026-10-09T13:00:00Z')).owner).toBe('person');
  });
});
