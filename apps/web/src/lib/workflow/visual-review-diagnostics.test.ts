import { describe, expect, it } from 'bun:test';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import { deriveMissionVisualReview } from './visual-review-state';
import { buildProblemReport, redactDiagnosticText } from './visual-review-diagnostics';

describe('redactDiagnosticText', () => {
  it('removes links, including ones that carry tokens in the query', () => {
    const out = redactDiagnosticText('failed at https://preview.example.com/app?x-vercel-protection-bypass=abc123def456&token=zzz and http://localhost:3000/a');
    expect(out).not.toMatch(/https?:|abc123|zzz|localhost/);
    expect(out).toContain('[link removed]');
  });
  it('removes keys, bearer tokens and long opaque strings', () => {
    const out = redactDiagnosticText('Authorization: Bearer eyJhbGciOi.payload.sig bld_0123456789abcdef ghp_abcdefghijklmnopqrstuvwxyz0123456789 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA AKIAABCDEFGHIJKLMNOP');
    expect(out).not.toMatch(/eyJ|bld_0123|ghp_|sk-ant|AKIA/);
  });
  it('removes email addresses and key=value secrets', () => {
    const out = redactDiagnosticText('user sam@example.com password=hunter2 secret: abc');
    expect(out).not.toMatch(/sam@|hunter2/);
  });
  it('keeps short plain words and short shas', () => {
    expect(redactDiagnosticText('stalled on abc1234 after 2 tries')).toBe('stalled on abc1234 after 2 tries');
  });
  it('caps length', () => {
    expect(redactDiagnosticText('x '.repeat(2000)).length).toBeLessThanOrEqual(600);
  });
});

describe('buildProblemReport', () => {
  const state = deriveMissionVisualReview({
    policy: resolveVisualReviewPolicy({}),
    uiChange: { state: 'yes', source: 'diff', uiFiles: 4 },
    audit: { id: '8237cfa9-aaaa-bbbb-cccc-111122223333', createdAt: '2026-10-01T00:00:00Z', errorType: null },
    review: { phase: 'failed', screens: 0, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null },
    waiver: null,
    branch: { headSha: 'abcdef1234567890abcdef1234567890abcdef12', base: 'dev', integrationPr: { number: 9, state: 'open', ready: false, blocked: false }, workLanded: true },
    autoRetriesLeft: 0,
  });

  it('describes the failure by cause and stage, never as a product finding', () => {
    const r = buildProblemReport(state, { note: 'It failed again https://x.example/?token=abc' });
    expect(r.title).toBe('Visual check could not run');
    expect(r.body).toContain('Cause: auditor_failed');
    expect(r.body).toContain('Policy: automatic');
    expect(r.body).toContain('Head: abcdef1');
    expect(r.body).not.toMatch(/findings?:/i);
  });

  it('carries only the short audit id and a sanitized note', () => {
    const r = buildProblemReport(state, { note: 'see https://x.example/?token=abc sam@example.com' });
    expect(r.body).toContain('Check: 8237cfa9');
    expect(r.body).not.toContain('8237cfa9-aaaa');
    expect(r.body).not.toMatch(/https?:|token=abc|sam@/);
  });

  it('refuses a state with no system failure to report', () => {
    const passed = deriveMissionVisualReview({ ...{
      policy: resolveVisualReviewPolicy({}), uiChange: { state: 'yes', source: 'diff', uiFiles: 1 }, waiver: null,
      branch: { headSha: null, base: null, integrationPr: null, workLanded: true },
    }, audit: { id: 'a', createdAt: null, errorType: null }, review: { phase: 'reviewed', screens: 1, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null } });
    expect(buildProblemReport(passed, {})).toBeNull();
  });
});
