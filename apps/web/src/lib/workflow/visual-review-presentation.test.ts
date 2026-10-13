import { describe, expect, it } from 'bun:test';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import { deriveMissionVisualReview, type VisualReviewStateInput } from './visual-review-state';
import { presentVisualReview, type VisualReviewPresentation } from './visual-review-presentation';

const base = (over: Partial<VisualReviewStateInput> = {}): VisualReviewStateInput => ({
  policy: resolveVisualReviewPolicy({}),
  uiChange: { state: 'yes', source: 'diff', uiFiles: 3 },
  audit: null,
  review: null,
  waiver: null,
  branch: { headSha: 'abc123', base: 'dev', integrationPr: null, workLanded: true },
  ...over,
});
const audit = { id: 't1', createdAt: '2026-10-01T00:00:00Z', errorType: null };
const review = (over: Record<string, unknown> = {}) => ({
  phase: 'reviewed' as const, screens: 4, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false,
  needsYouReason: null, captured: 0, expected: null, ...over,
});
const pr = (over: Record<string, unknown> = {}) => ({ number: 9, state: 'open' as const, ready: false, blocked: false, ...over });
const present = (over: Partial<VisualReviewStateInput> = {}, opts?: Parameters<typeof presentVisualReview>[1]) =>
  presentVisualReview(deriveMissionVisualReview(base(over)), opts);

/** Every string the owner can read. */
function copyOf(p: VisualReviewPresentation): string {
  return [p.label, p.detail, p.owner?.label, p.owner?.detail, p.record?.text, p.record?.detail, p.report?.label, p.report?.detail]
    .filter(Boolean).join(' | ');
}
const MECHANICS = /\b(tasks?|workers?|agents?|glob|globs|api|http|https|json|sha|ui files?|surface audit|\[surface)\b/i;

describe('presentVisualReview: stages', () => {
  it('shows nothing when no UI changed and nothing ran, but keeps a distinct automatic record', () => {
    const p = present({ uiChange: { state: 'no', source: null, uiFiles: 0 } });
    expect(p).toMatchObject({ stage: 'none', showPanel: false, needsYou: false });
    expect(p.record).toMatchObject({ kind: 'auto_no_impact' });
  });

  it('is quiet when the policy is off', () => {
    expect(present({ policy: resolveVisualReviewPolicy({ workspace: 'off' }) })).toMatchObject({ stage: 'none', showPanel: false, needsYou: false });
  });

  it('a needed review under automatic is the system’s: verifying, never the owner', () => {
    const p = present({ branch: { headSha: 'abc123', base: 'dev', integrationPr: pr(), workLanded: true } });
    expect(p).toMatchObject({ stage: 'verifying', nextActor: 'system', needsYou: false, owner: null, showPanel: true });
  });

  it('running shows capture progress', () => {
    const p = present({ audit, review: review({ phase: 'capturing', captured: 3, expected: 8 }) });
    expect(p.stage).toBe('verifying');
    expect(p.detail).toContain('3 of 8');
  });

  it('open fixes read as fixing, with the count', () => {
    const p = present({ audit, review: review({ phase: 'fixing', effectiveIssues: 2, openFixes: 2 }) });
    expect(p).toMatchObject({ stage: 'fixing', needsYou: false, nextActor: 'system' });
    expect(p.label).toContain('2');
  });

  it('flagged screens awaiting Jev are not an owner decision', () => {
    const p = present({ audit, review: review({ phase: 'needs_you', awaitingHuman: 2, effectiveIssues: 2, needsYouReason: 'unsure' }) });
    expect(p).toMatchObject({ stage: 'verifying', needsYou: false, owner: null });
  });

  it('passed with a ready integration PR reads Ready to merge', () => {
    const p = present({ audit, review: review(), auditedSha: 'abc123', branch: { headSha: 'abc123', base: 'dev', integrationPr: pr({ ready: true }), workLanded: true } });
    expect(p).toMatchObject({ stage: 'ready', label: 'Ready to merge', needsYou: false });
  });

  it('Merge now is the owner’s only where the merge policy asks a person', () => {
    const input = { audit, review: review(), auditedSha: 'abc123', branch: { headSha: 'abc123', base: 'dev', integrationPr: pr({ ready: true }), workLanded: true } };
    const p = present(input, { ownerMergesIntegration: true });
    expect(p).toMatchObject({ stage: 'ready', needsYou: true });
    expect(p.owner).toMatchObject({ kind: 'merge_now' });
  });

  it('a merged integration PR reads Merged', () => {
    const p = present({ audit, review: review(), auditedSha: 'abc123', branch: { headSha: 'abc123', base: 'dev', integrationPr: pr({ state: 'merged', ready: true }), workLanded: true } });
    expect(p).toMatchObject({ stage: 'merged', label: 'Merged', needsYou: false });
  });

  it('passed without an integration PR yet shows only a record', () => {
    const p = present({ audit, review: review() });
    expect(p).toMatchObject({ stage: 'none', showPanel: false });
    expect(p.record).toMatchObject({ kind: 'passed' });
  });
});

describe('presentVisualReview: owner decisions', () => {
  it('automatic never offers Run or Waive for changed UI files', () => {
    for (const workLanded of [true, false]) {
      const p = present({ uiChange: { state: 'yes', source: 'diff', uiFiles: 40 }, branch: { headSha: 'abc123', base: 'dev', integrationPr: null, workLanded } });
      expect(p.needsYou).toBe(false);
      expect(p.owner).toBeNull();
      expect(copyOf(p)).not.toMatch(/waive|run visual/i);
    }
  });

  it('strict has no owner decision and no waiver', () => {
    const p = present({ policy: resolveVisualReviewPolicy({ workspace: 'strict' }) });
    expect(p).toMatchObject({ needsYou: false, owner: null, canWaive: false });
  });

  it('ask asks once: Run visual review, with no inline waiver', () => {
    const p = present({ policy: resolveVisualReviewPolicy({ workspace: 'ask' }) });
    expect(p).toMatchObject({ needsYou: true });
    expect(p.owner).toMatchObject({ kind: 'run_review', label: 'Run visual review' });
    expect(copyOf(p)).not.toMatch(/waive/i);
  });

  it('exhausted fixes become a genuine visual judgment', () => {
    const p = present({ audit, review: review({ phase: 'needs_you', effectiveIssues: 3, roundCapOpen: true, needsYouReason: 'round_cap' }) });
    expect(p.needsYou).toBe(true);
    expect(p.owner).toMatchObject({ kind: 'judge' });
    expect(p.owner?.label).toContain('3');
    expect(p.canWaive).toBe(true);
  });

  it('a workspace capture problem is the owner’s setup to fix, and names no secret or URL', () => {
    const p = present({ audit, review: review({ phase: 'failed' }), captureConfigError: 'protection_bypass_missing' });
    expect(p.needsYou).toBe(true);
    expect(p.owner).toMatchObject({ kind: 'fix_setup' });
    expect(p.problem).toBe('system');
    expect(copyOf(p)).not.toMatch(/https?:|protection_bypass/i);
  });
});

describe('presentVisualReview: failures are not findings', () => {
  it('a system failure with retries left retries first and is not an owner decision', () => {
    const p = present({ audit, review: review({ phase: 'failed' }), autoRetriesLeft: 2 });
    expect(p).toMatchObject({ stage: 'blocked', problem: 'system', needsYou: false, nextActor: 'system' });
    expect(p.label).toBe('Retrying the visual check');
    expect(p.report).not.toBeNull();
  });

  it('after retries run out the owner can report a Buildd problem, which is not a finding', () => {
    const p = present({ audit, review: review({ phase: 'failed' }), autoRetriesLeft: 0 });
    expect(p).toMatchObject({ stage: 'blocked', problem: 'system', needsYou: true });
    expect(p.owner).toMatchObject({ kind: 'report' });
    expect(p.report?.label).toBe('Report a Buildd problem');
    expect(p.findings).toBeNull();
  });

  it('a product finding is never labelled as a problem with Buildd', () => {
    const p = present({ audit, review: review({ phase: 'fixing', effectiveIssues: 1, openFixes: 1 }) });
    expect(p.problem).toBe('product');
    expect(p.report).toBeNull();
  });
});

describe('presentVisualReview: records', () => {
  const waiver = { reason: 'Emergency copy fix', actorLabel: 'sam@example.com', at: '2026-10-02T10:00:00Z' };

  it('a waiver is a person’s record with reason, actor, time and policy, distinct from an automatic skip', () => {
    const p = present({ waiver, policy: resolveVisualReviewPolicy({ workspace: 'ask' }) });
    expect(p.stage).toBe('waived');
    expect(p.record).toMatchObject({ kind: 'waiver', reason: 'Emergency copy fix', actor: 'sam@example.com', at: '2026-10-02T10:00:00Z', policy: 'ask' });
    const auto = present({ uiChange: { state: 'no', source: null, uiFiles: 0 } });
    expect(auto.record?.kind).toBe('auto_no_impact');
    expect(auto.record?.kind).not.toBe(p.record?.kind);
  });
});

describe('presentVisualReview: copy', () => {
  const policies = ['strict', 'automatic', 'ask', 'off'] as const;
  const scenarios: Array<[string, Partial<VisualReviewStateInput>]> = [
    ['nothing run', {}],
    ['queued', { audit, review: review({ phase: 'queued' }) }],
    ['running', { audit, review: review({ phase: 'capturing', captured: 1, expected: 4 }) }],
    ['fixing', { audit, review: review({ phase: 'fixing', effectiveIssues: 1, openFixes: 1 }) }],
    ['jev', { audit, review: review({ phase: 'needs_you', awaitingHuman: 1, needsYouReason: 'unsure' }) }],
    ['exhausted', { audit, review: review({ phase: 'needs_you', effectiveIssues: 1, roundCapOpen: true }) }],
    ['boot failed', { audit, review: review({ phase: 'boot_failed' }) }],
    ['stalled', { audit, review: review({ phase: 'stalled' }), autoRetriesLeft: 0 }],
    ['preview', { audit, review: review({ phase: 'failed' }), captureConfigError: 'preview_unavailable' }],
    ['passed', { audit, review: review(), branch: { headSha: 'abc123', base: 'dev', integrationPr: pr({ ready: true }), workLanded: true } }],
  ];

  it('never leaks agent or task mechanics, raw codes, globs or duplicate warnings', () => {
    for (const mode of policies) {
      for (const [name, over] of scenarios) {
        const p = present({ ...over, policy: resolveVisualReviewPolicy({ workspace: mode }) }, { ownerMergesIntegration: true });
        const text = copyOf(p);
        expect(text, `${mode}/${name}`).not.toMatch(MECHANICS);
        expect(text, `${mode}/${name}`).not.toMatch(/[—–]/);
        expect(text, `${mode}/${name}`).not.toMatch(/\*|\.tsx?\b|_[a-z]+_/);
      }
    }
  });

  it('only an actual owner decision raises Needs You, across every policy and scenario', () => {
    for (const mode of policies) {
      for (const [, over] of scenarios) {
        const p = present({ ...over, policy: resolveVisualReviewPolicy({ workspace: mode }) });
        expect(p.needsYou).toBe(p.owner !== null);
        if (p.needsYou) expect(p.nextActor).toBe('owner');
      }
    }
  });
});
