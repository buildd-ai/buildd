import { describe, expect, it } from 'bun:test';
import { DECISION_AUDIT_SCHEDULE, decisionAuditArtifactKey, isoWeek } from '../decision-audit-schedule';

describe('isoWeek', () => {
  it('numbers weeks the ISO way, including across a year boundary', () => {
    expect(isoWeek(new Date('2026-10-12T09:00:00Z'))).toBe('2026-W42');
    expect(isoWeek(new Date('2026-10-11T23:59:59Z'))).toBe('2026-W41');
    // 1 Jan 2027 is a Friday: still ISO week 53 of 2026.
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    // 29 Dec 2025 is a Monday in ISO week 1 of 2026.
    expect(isoWeek(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01');
  });
});

describe('decisionAuditArtifactKey', () => {
  it('names the week graded (last week), not the week the run fires in', () => {
    expect(decisionAuditArtifactKey(new Date('2026-10-12T09:00:00Z'))).toBe('decision-audit-2026-W41');
  });
});

describe('DECISION_AUDIT_SCHEDULE', () => {
  it('fires Mondays as a premium researcher task', () => {
    expect(DECISION_AUDIT_SCHEDULE.cronExpression).toMatch(/^\d+ \d+ \* \* 1$/);
    expect(DECISION_AUDIT_SCHEDULE.title).toBe("[decision audit] grade last week's decisions");
    expect(DECISION_AUDIT_SCHEDULE.roleSlug).toBe('researcher');
    expect(DECISION_AUDIT_SCHEDULE.tier).toBe('premium');
  });

  it('tells the auditor to stratify, judge from evidence, label, and write one keyed report', () => {
    const d = DECISION_AUDIT_SCHEDULE.description;
    for (const needle of ['get_decision_stats', 'get_decision', 'label_decision', 'create_artifact', 'decision-audit-', 'up to 20', 'acted', 'recorded-only', 'fallback', 'unsure', 'ruleLabel']) {
      expect(d, needle).toContain(needle);
    }
    // Short enough to stay instructions, not an essay.
    expect(d.length).toBeLessThan(3500);
  });

  it('finds the features from the ledger itself, so a new decision kind is audited without editing the template', () => {
    expect(DECISION_AUDIT_SCHEDULE.description).toContain('capability: "*"');
  });
});
