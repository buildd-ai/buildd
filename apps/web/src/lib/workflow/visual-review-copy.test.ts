import { describe, expect, it } from 'bun:test';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import { deriveMissionVisualReview, type VisualReviewStateInput } from './visual-review-state';
import { presentVisualReview, visualReviewDiagnostics } from './visual-review-copy';
import type { VisualReviewPolicyMode } from '@buildd/shared';

const policy = (mode: VisualReviewPolicyMode) => resolveVisualReviewPolicy({ workspace: mode });

function state(over: Partial<VisualReviewStateInput> & { mode?: VisualReviewPolicyMode } = {}) {
  const { mode = 'automatic', ...rest } = over;
  return deriveMissionVisualReview({
    policy: policy(mode),
    uiChange: { state: 'yes', source: 'diff', uiFiles: 3 },
    audit: null,
    review: null,
    waiver: null,
    branch: { headSha: 'abc1234', base: 'dev', integrationPr: { number: 5, state: 'open', ready: false, blocked: false }, workLanded: true },
    ...rest,
  });
}

const review = (over: Partial<NonNullable<VisualReviewStateInput['review']>> = {}): NonNullable<VisualReviewStateInput['review']> => ({
  phase: 'reviewed', screens: 4, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false,
  needsYouReason: null, captured: 4, expected: 4, ...over,
});
const audit = { id: 'a1', createdAt: '2026-10-01T00:00:00Z', errorType: null };

describe('no spurious Needs You', () => {
  for (const mode of ['automatic', 'strict'] as const) {
    it(`${mode}: changed UI with no audit yet verifies on its own and asks nobody`, () => {
      const p = presentVisualReview(state({ mode }));
      expect(p.stageLabel).toBe('Verifying');
      expect(p.needsOwner).toBe(false);
      expect(p.ownerDecision).toBeNull();
    });
  }
  it('only the ask policy puts the run question to a person', () => {
    const p = presentVisualReview(state({ mode: 'ask' }));
    expect(p.needsOwner).toBe(true);
    expect(p.ownerDecision?.kind).toBe('ask_policy');
  });
  it('never offers a waive prompt under automatic while running', () => {
    const p = presentVisualReview(state({ audit, review: review({ phase: 'capturing', expected: 6, captured: 2 }) }));
    expect(p.needsOwner).toBe(false);
    expect(p.detail).toBe('Checked 2 of 6 screens.');
  });
  it('a ready, verified branch offers Merge now without raising Needs You', () => {
    const p = presentVisualReview(state({
      audit, review: review(), auditedSha: 'abc1234',
      branch: { headSha: 'abc1234', base: 'dev', integrationPr: { number: 5, state: 'open', ready: true, blocked: false }, workLanded: true },
    }));
    expect(p.stageLabel).toBe('Ready to merge');
    expect(p.ownerDecision?.label).toBe('Merge now');
    expect(p.needsOwner).toBe(false);
  });
  it('a screen the system is fixing is Fixing, not an owner ask', () => {
    const p = presentVisualReview(state({ audit, review: review({ phase: 'fixing', effectiveIssues: 2, openFixes: 1 }) }));
    expect(p.stage).toBe('fixing');
    expect(p.needsOwner).toBe(false);
  });
});

describe('system failure vs product finding', () => {
  it('a first browser failure retries quietly and is not a finding', () => {
    const p = presentVisualReview(state({ audit, review: review({ phase: 'failed' }), autoRetriesLeft: 1 }));
    expect(p.problem).toEqual({ kind: 'system', cause: 'buildd', retrying: true });
    expect(p.findings).toBeNull();
    expect(p.needsOwner).toBe(false);
    expect(p.detail).toBe('The check hit a problem on our side and is trying again.');
  });
  it('after retries run out the owner can report a Buildd problem', () => {
    const p = presentVisualReview(state({ audit, review: review({ phase: 'failed' }), autoRetriesLeft: 0 }));
    expect(p.ownerDecision).toEqual({ kind: 'report', label: 'Report a Buildd problem' });
    expect(p.findings).toBeNull();
  });
  it('a setup problem is the workspace\'s, and says so', () => {
    const p = presentVisualReview(state({ audit, review: review({ phase: 'failed' }), captureConfigError: 'app_auth_not_configured' }));
    expect(p.ownerDecision?.kind).toBe('setup');
    expect(p.problem).toMatchObject({ cause: 'workspace' });
  });
  it('a product finding carries counts and no problem', () => {
    const p = presentVisualReview(state({ audit, review: review({ phase: 'fixing', effectiveIssues: 2, openFixes: 1 }) }));
    expect(p.problem).toBeNull();
    expect(p.findings).toEqual({ issues: 2, undecided: 0, fixesOpen: 1 });
  });
  it('diagnostics carry a closed field list: no urls, shas or free text', () => {
    const s = state({ audit, review: review({ phase: 'failed' }), autoRetriesLeft: 0 });
    const d = visualReviewDiagnostics(s);
    expect(Object.keys(d).sort()).toEqual(['cause', 'causeOwner', 'integrationPr', 'policy', 'retriesLeft', 'screens', 'staleEvidence', 'status']);
    expect(JSON.stringify(d)).not.toMatch(/https?:|abc1234/);
  });
});

describe('records', () => {
  it('a waiver names who, when, why and under which policy', () => {
    const p = presentVisualReview(state({ mode: 'automatic', waiver: { reason: 'Copy-only change', actorLabel: 'Sam', at: '2026-10-02T12:00:00Z', policy: 'automatic' } }));
    expect(p.waiverRecord?.line).toBe('Visual review waived by Sam on Oct 2: Copy-only change. Policy: automatic.');
    expect(p.autoDecisionRecord).toBeNull();
  });
  it('an automatic no-impact decision reads differently from a waiver', () => {
    const p = presentVisualReview(state({
      uiChange: { state: 'no', source: 'diff', uiFiles: 0 },
      autoDecision: { basis: 'rule', at: '2026-10-02T12:00:00Z', headSha: 'abc1234' },
    }));
    expect(p.autoDecisionRecord?.line).toMatch(/^Visual review not needed\./);
    expect(p.waiverRecord).toBeNull();
    expect(p.showPanel).toBe(false);
    expect(p.recordLine).toMatch(/not needed/);
  });
});

describe('panel is shown only when informative', () => {
  it('hidden with no UI change and no integration branch', () => {
    const p = presentVisualReview(state({ uiChange: { state: 'no', source: null, uiFiles: 0 }, branch: { headSha: null, base: 'dev', integrationPr: null, workLanded: false } }));
    expect(p.showPanel).toBe(false);
  });
  it('shown while verifying', () => {
    expect(presentVisualReview(state()).showPanel).toBe(true);
  });
  it('copy never names a task, glob, url or sha', () => {
    const all = [state(), state({ mode: 'ask' }), state({ audit, review: review({ phase: 'failed' }), autoRetriesLeft: 0 })]
      .map(presentVisualReview).map(p => `${p.stageLabel} ${p.detail ?? ''}`).join(' ');
    expect(all).not.toMatch(/task|\*\*|https?:|abc1234|audit|api/i);
  });
});
