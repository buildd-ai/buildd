import { describe, expect, it } from 'bun:test';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import {
  assessVisualImpact,
  classifyImpactFile,
  isImpactAssessmentCurrent,
  uiChangeFromImpact,
  type ImpactDecider,
  type ImpactFile,
} from './visual-review-impact';
import { deriveMissionVisualReview } from './visual-review-state';

const patch = (...lines: string[]) => ['@@ -1,3 +1,3 @@', ...lines].join('\n');
const policy = (mode: 'strict' | 'automatic' | 'ask' | 'off') => resolveVisualReviewPolicy({ workspace: mode });

const calls: unknown[] = [];
const deciderOf = (answer: Partial<Awaited<ReturnType<ImpactDecider>>> | Error): ImpactDecider => async f => {
  calls.push(f);
  if (answer instanceof Error) throw answer;
  return { decision: 'no_visual_impact', confidence: 0.95, reasonCode: 'reason_logic_only', source: 'model', ...answer };
};
const never: ImpactDecider = async () => { throw new Error('model must not be asked'); };

// A UI-path file whose change is plausible either way: Jev's to judge.
const ambiguous: ImpactFile = {
  path: 'apps/web/src/components/useThing.ts',
  patch: patch(' export function useThing() {', '-  return a;', '+  return a + 1;', ' }'),
};
const run = (over: Partial<Parameters<typeof assessVisualImpact>[0]> & { files: ImpactFile[] | null }) =>
  assessVisualImpact({ policy: policy('automatic'), headSha: 'sha1', decide: never, ...over });

describe('classifyImpactFile', () => {
  it('tests, types, docs and api routes under UI paths never render', () => {
    for (const path of [
      'apps/web/src/components/Button.test.tsx',
      'apps/web/src/app/api/x/route.ts',
      'apps/web/src/components/types.d.ts',
      'docs/specs/foo.md',
      'packages/core/foo.ts',
    ]) expect(classifyImpactFile({ path })).toBe('no_render');
  });
  it('comment-only and type-only edits to a component are inert', () => {
    expect(classifyImpactFile({ path: 'apps/web/src/components/Card.tsx', patch: patch('+// explain', '-/* old */', '+import type { X } from "./x";') })).toBe('no_render');
  });
  it('server-only modules are inert', () => {
    expect(classifyImpactFile({ path: 'apps/web/src/lib/x.tsx', patch: patch(" import 'server-only';", '+const a = 1;') })).toBe('no_render');
  });
  it('css, tokens and tailwind config are protected', () => {
    for (const path of ['apps/web/src/app/globals.css', 'packages/ui/tokens.ts', 'apps/web/tailwind.config.ts', 'apps/web/src/styles/theme.ts']) {
      expect(classifyImpactFile({ path })).toBe('style');
    }
  });
  it('route screens and risky flows are protected', () => {
    expect(classifyImpactFile({ path: 'apps/web/src/app/app/page.tsx', patch: patch('+<div/>') })).toBe('screen');
    expect(classifyImpactFile({ path: 'apps/web/src/components/billing/Plan.tsx', patch: patch('+<b>x</b>') })).toBe('risky_flow');
  });
  it('other component code is a candidate', () => {
    expect(classifyImpactFile({ path: 'apps/web/src/components/Card.tsx', patch: patch('+<b>x</b>') })).toBe('candidate');
  });
});

describe('assessVisualImpact', () => {
  it('auto-skips a UI-path touch with only tests, types and comments (deterministic, no model)', async () => {
    const a = await run({
      files: [
        { path: 'apps/web/src/components/Button.test.tsx', patch: patch('+it()') },
        { path: 'apps/web/src/components/Card.tsx', patch: patch('+// note') },
        { path: 'apps/web/src/app/api/x/route.ts', patch: patch('+x') },
      ],
    });
    expect(a).toMatchObject({ verdict: 'not_applicable', basis: 'rule', recordKind: 'applicability', headSha: 'sha1', reversible: true });
    expect(a.reasons[0].code).toBe('no_render_changes');
    expect(a.evidence).toMatchObject({ filesInspected: 3, noRenderFiles: 3, diffRead: true });
  });

  it('an empty diff has no render impact', async () => {
    expect((await run({ files: [] })).reasons[0].code).toBe('no_render_files');
  });

  it('CSS / token changes require review by rule without asking the model', async () => {
    const a = await run({ files: [{ path: 'apps/web/src/app/globals.css', patch: patch('+a{}') }] });
    expect(a).toMatchObject({ verdict: 'review_required', basis: 'rule' });
    expect(a.reasons.map(r => r.code)).toEqual(['protected_style']);
  });

  it('ambiguous: a confident model "no impact" is an applicability skip, recorded with model basis, SHA and confidence', async () => {
    const a = await run({ files: [ambiguous], decide: deciderOf({}) });
    expect(a).toMatchObject({ verdict: 'not_applicable', basis: 'model', confidence: 0.95, headSha: 'sha1', recordKind: 'applicability' });
    expect(a.reasons[0]).toEqual({ code: 'model_no_visual_impact', modelReason: 'logic_only' });
    expect(a).not.toHaveProperty('waiver');
  });

  it('the model sees bounded counts, never paths or text', async () => {
    calls.length = 0;
    await run({ files: [ambiguous], decide: deciderOf({}) });
    const f = calls[0] as Record<string, unknown>;
    expect(f).toMatchObject({ candidateFiles: 1, addedLines: 1, removedLines: 1, markupLines: 0, protectedHit: false });
    expect(JSON.stringify(f)).not.toContain('useThing');
  });

  it('ambiguous: model review_required / insufficient_evidence / low confidence all run the audit', async () => {
    const r = await run({ files: [ambiguous], decide: deciderOf({ decision: 'review_required', reasonCode: 'reason_markup_changed' }) });
    expect(r).toMatchObject({ verdict: 'review_required', basis: 'model' });
    const i = await run({ files: [ambiguous], decide: deciderOf({ decision: 'insufficient_evidence' }) });
    expect(i).toMatchObject({ verdict: 'review_required', basis: 'fail_safe' });
    expect(i.reasons[0].code).toBe('model_insufficient_evidence');
    const low = await run({ files: [ambiguous], decide: deciderOf({ confidence: 0.4 }) });
    expect(low).toMatchObject({ verdict: 'review_required', basis: 'fail_safe' });
    expect(low.reasons[0].code).toBe('model_low_confidence');
  });

  it('a substrate fallback (no route, low confidence under threshold) is review_required', async () => {
    const a = await run({ files: [ambiguous], decide: deciderOf({ source: 'fallback', decision: 'review_required', confidence: null, reasonCode: 'fallback_low_confidence' }) });
    expect(a).toMatchObject({ verdict: 'review_required', basis: 'fail_safe' });
    expect(a.reasons[0].code).toBe('model_low_confidence');
    const none = await run({ files: [ambiguous], decide: deciderOf({ source: 'fallback', decision: 'review_required', confidence: null, reasonCode: 'fallback_no_provider' }) });
    expect(none.reasons[0].code).toBe('model_error');
  });

  it('a model error runs the audit', async () => {
    const a = await run({ files: [ambiguous], decide: deciderOf(new Error('boom')) });
    expect(a).toMatchObject({ verdict: 'review_required', basis: 'fail_safe' });
    expect(a.reasons[0].code).toBe('model_error');
  });

  it('a missing diff runs the audit without asking anyone', async () => {
    const a = await run({ files: null });
    expect(a).toMatchObject({ verdict: 'review_required', basis: 'fail_safe', evidence: { diffRead: false } });
    expect(a.reasons[0].code).toBe('diff_unavailable');
  });

  it('a candidate with no diff text, or no head SHA, is not asked about', async () => {
    expect((await run({ files: [{ path: 'apps/web/src/components/A.tsx' }] })).reasons[0].code).toBe('diff_incomplete');
    expect((await run({ files: [ambiguous], headSha: null })).reasons[0].code).toBe('head_unknown');
  });

  describe('policy', () => {
    it('off => not_applicable(policy), no diff needed, no model', async () => {
      const a = await run({ policy: policy('off'), files: null });
      expect(a).toMatchObject({ verdict: 'not_applicable', basis: 'policy', policyMode: 'off' });
      expect(a.reasons[0].code).toBe('policy_off');
    });
    it('strict never skips by model, and does not ask it', async () => {
      const a = await run({ policy: policy('strict'), files: [ambiguous] });
      expect(a).toMatchObject({ verdict: 'review_required', basis: 'policy' });
      expect(a.reasons[0].code).toBe('strict_no_model_skip');
    });
    it('strict still skips a deterministic no-render change', async () => {
      expect((await run({ policy: policy('strict'), files: [{ path: 'docs/a.md' }] })).verdict).toBe('not_applicable');
    });
    it('automatic and ask both let a confident model skip; the owner prompt is the state\'s concern', async () => {
      for (const m of ['automatic', 'ask'] as const) {
        expect((await run({ policy: policy(m), files: [ambiguous], decide: deciderOf({}) })).verdict).toBe('not_applicable');
      }
    });
  });
});

describe('head SHA invalidation', () => {
  it('holds only for the SHA it was made on', async () => {
    const a = await run({ files: [ambiguous], decide: deciderOf({}) });
    expect(isImpactAssessmentCurrent(a, 'sha1')).toBe(true);
    expect(isImpactAssessmentCurrent(a, 'sha2')).toBe(false);
    expect(isImpactAssessmentCurrent(a, null)).toBe(false);
  });
  it('a stale model skip no longer reads as "no UI change" in the canonical state', async () => {
    const a = await run({ files: [ambiguous], decide: deciderOf({}) });
    expect(uiChangeFromImpact(a, 'sha1')).toMatchObject({ state: 'no' });
    expect(uiChangeFromImpact(a, 'sha2')).toMatchObject({ state: 'unknown' });
  });
  it('feeds the state: model skip => not_applicable, fail-safe => needed', async () => {
    const mk = (uiChange: ReturnType<typeof uiChangeFromImpact>, mode: 'automatic' | 'off' = 'automatic') => deriveMissionVisualReview({
      policy: policy(mode), uiChange, audit: null, review: null, waiver: null,
      branch: { headSha: 'sha1', base: 'dev', integrationPr: null, workLanded: true },
    });
    expect(mk(uiChangeFromImpact(await run({ files: [ambiguous], decide: deciderOf({}) }), 'sha1')).status).toBe('not_applicable');
    expect(mk(uiChangeFromImpact(await run({ files: [ambiguous], decide: deciderOf(new Error('x')) }), 'sha1')).status).toBe('needed');
    expect(mk(uiChangeFromImpact(await run({ policy: policy('off'), files: null }), 'sha1'), 'off').status).toBe('not_applicable');
  });
  it('strict on an ambiguous change still runs the audit (policy basis is not a policy-off skip)', async () => {
    const a = await run({ policy: policy('strict'), files: [ambiguous] });
    expect(uiChangeFromImpact(a, 'sha1')).toMatchObject({ state: 'yes' });
    expect(uiChangeFromImpact(a, 'sha2')).toMatchObject({ state: 'unknown' });
    const state = deriveMissionVisualReview({
      policy: policy('strict'), uiChange: uiChangeFromImpact(a, 'sha1'), audit: null, review: null, waiver: null,
      branch: { headSha: 'sha1', base: 'dev', integrationPr: null, workLanded: true },
    });
    expect(state.status).toBe('needed');
  });
});
