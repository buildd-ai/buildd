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
 * the protected-path, data-migration, security and reviewer-escalated
 * mission-ship shapes are a person's; every other one has a named machine owner.
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
    name: 'a security-tagged review, CI not green yet',
    subject: base({ why: 'reviewer_escalated', ci: 'running', detail: 'Decide whether to drop an unverified branch; security scope' }),
    owner: 'person', rail: 'security',
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

  it('exactly four of the ten are a person\'s', () => {
    expect(SHAPES.filter(s => escalationRule(s.subject)?.owner === 'person')).toHaveLength(4);
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

  it('conflict fixes used up, with no reviewer concern to weigh, is the person\'s by rule (no Jev call)', () => {
    expect(escalationRule(base({ conflict: true, why: 'conflict_fixes_spent' }))).toMatchObject({ owner: 'person', by: 'rule' });
  });

  it('a reviewer escalation on a green, ordinary PR is Jev\'s', () => {
    expect(escalationRule(base({ why: 'reviewer_escalated', ci: 'green' }))).toBeNull();
  });

  it('an irreversible step named by landing goes to a person; a reviewer saying "merge this" does not', () => {
    expect(escalationRule(base({ why: 'landing_handoff', handoffCause: 'refresh_unsafe', handoffReason: 'Landing it needs a force push to the base branch' }))).toMatchObject({ owner: 'person', rail: 'irreversible' });
    expect(escalationRule(base({ why: 'reviewer_escalated', detail: 'Looks good, safe to merge this once a person signs off' }))).toBeNull();
  });

  it('a security concern in the escalation goes to a person; a passing mention does not', () => {
    expect(escalationRule(base({ why: 'reviewer_escalated', detail: 'Security concern: the token is logged' }))).toMatchObject({ owner: 'person', rail: 'security' });
    expect(escalationRule(base({ why: 'reviewer_escalated', detail: 'Adds a settings page; no auth changes' }))).toBeNull();
  });
});

describe('Jev only on a concern', () => {
  it.each([
    ['human_tier'], ['approved_needs_merge'], ['landing_handoff'], ['kernel_needs_you'], ['conflict_fixes_spent'],
  ] as const)('%s with no rule is the person\'s by rule, with the reason it reached them', why => {
    const v = escalationRule(base({ why, ci: 'green' }));
    expect(v).toMatchObject({ owner: 'person', by: 'rule' });
    expect(v!.reason.length).toBeGreaterThan(0);
  });

  it('only a reviewer escalation with no rule answer reaches Jev', () => {
    expect(escalationRule(base({ why: 'reviewer_escalated', ci: 'green' }))).toBeNull();
    expect(escalationRule(base({ why: 'review_exhausted', ci: 'green' }))).toBeNull();
  });

  it('Jev answers in under a second (backtest p50 ~0.2 s)', async () => {
    const { ESCALATION_GATE_DECISION_TIMEOUT_MS } = await import('../escalation-gate');
    expect(ESCALATION_GATE_DECISION_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
    expect(ESCALATION_GATE_DECISION_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
  });
});

describe('escalationRule: the backtest\'s findings', () => {
  const policyOnly = (over: Partial<EscalationSubject> = {}) => base({
    why: 'reviewer_escalated', ci: 'green', policyOnly: true, riskClasses: ['destructive_schema_change'], headIsCurrent: true,
    detail: 'Hard rule: schema changes require human review', ...over,
  });

  it('a policy-only escalation with every gate holding lands by rule, not by a person', () => {
    expect(escalationRule(policyOnly())).toMatchObject({ owner: 'buildd', action: 'policy_merge' });
    expect(escalationRule(policyOnly({ riskClasses: ['destructive_schema_change', 'public_api_contract'] }))).toMatchObject({ action: 'policy_merge' });
  });

  it.each([
    ['CI still running', { ci: 'running' as const }, 'wait_ci'],
    ['pushed since the review', { headIsCurrent: false }, null],
    ['a draft', { draft: true }, null],
    ['an XL diff', { sizeXl: true }, null],
    ['not policy only', { policyOnly: false }, null],
  ])('not when %s', (_n, over, action) => {
    const v = escalationRule(policyOnly(over as Partial<EscalationSubject>));
    if (action) expect(v).toMatchObject({ action });
    else expect(v).toBeNull();
  });

  it('workflow and secrets paths always go to a person', () => {
    expect(escalationRule(policyOnly({ riskClasses: ['ci_deploy_config'] }))).toMatchObject({ owner: 'person', rail: 'protected_path' });
    expect(escalationRule(policyOnly({ riskClasses: ['destructive_schema_change', 'auth_and_secrets'] }))).toMatchObject({ owner: 'person', rail: 'protected_path' });
  });

  it('a data migration UPDATE goes to a person even when policy only', () => {
    expect(escalationRule(policyOnly({ detail: 'Hard rule: runs data migration UPDATE on tasks' }))).toMatchObject({ owner: 'person', rail: 'data_migration' });
  });

  it('a collision named in the escalation is a renumber', () => {
    expect(escalationRule(base({ why: 'reviewer_escalated', detail: 'Migration index collision: renumber 0277' }))).toMatchObject({ owner: 'buildd', action: 'renumber_migration' });
  });

  it('Jev is never offered a merge', async () => {
    const { JEV_ACTIONS } = await import('../escalation-gate');
    expect(JEV_ACTIONS as readonly string[]).not.toContain('retry_landing');
    expect(JEV_ACTIONS as readonly string[]).not.toContain('policy_merge');
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
