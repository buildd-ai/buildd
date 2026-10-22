/**
 * The registered UI checks' collector (scripts/qa/surface-evidence.ts) run over
 * the real cards' `data-verify-*` markup, mounted from the dev fixtures the QA
 * plan captures (scripts/qa/plans/ui-verify-surfaces.json), with the facts that
 * plan supplies (ui-verify-surfaces.facts.json).
 *
 * happy-dom does no layout, so `checkVisibility` stands in for the browser's:
 * an element is rendered unless it or an ancestor is `display: none`.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

mock.module('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(Element.prototype as unknown as { checkVisibility: () => boolean }).checkVisibility = function (this: Element) {
  for (let el: Element | null = this; el; el = el.parentElement) if ((el as HTMLElement).style?.display === 'none') return false;
  return true;
};

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionSituationBlock, MISSION_SITUATION_SURFACE } = await import('./MissionSituationBlock');
const { default: VisualReviewTray, VISUAL_REVIEW_SURFACE } = await import('@/components/visual-review/VisualReviewTray');
const { buildVisualReviewFixtureModel } = await import('@/lib/visual-review-model.fixtures');
const { CLOSED_PR_MISSION_ID, closedPrFixture } = await import('@/app/app/dev/fixtures/closed-pr-fixtures');
const { parseVisualReviewFixtureParams } = await import('@/app/app/dev/fixtures/visual-review-fixtures');
const { composeSurfaceEvidence, parseSurfaceFacts, readSurfaceDom } = await import('../../../../../scripts/qa/surface-evidence');
const { parsePlan } = await import('../../../../../scripts/qa/steps');
const { runUiActionStateCheck } = await import('@buildd/core/ui-verification');

const QA = join(import.meta.dir, '../../../../../scripts/qa/plans');
const facts = parseSurfaceFacts(join(QA, 'ui-verify-surfaces.facts.json'), p => readFileSync(p, 'utf-8'))!;

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (el: React.ReactElement) => act(() => root.render(el));

function capture(surface: string, scenarioId: string) {
  const r = composeSurfaceEvidence(readSurfaceDom(surface), {
    commitSha: 'a'.repeat(40), route: '/app/dev/fixtures', scenarioId, viewport: 'mobile',
    captureId: `${scenarioId}@2026-10-22T00:00:00.000Z`, capturedAt: '2026-10-22T00:00:00.000Z',
    snapshotRef: `surfaces/${scenarioId}.json`, screenshot: true, facts, collector: 'visual_auditor',
  });
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const closedPr = (c: Parameters<typeof closedPrFixture>[0]) =>
  render(<MissionSituationBlock missionId={CLOSED_PR_MISSION_ID} situation={closedPrFixture(c).situation} because={[]} />);

describe('the QA plan names every new surface and supplies facts for each scenario', () => {
  it('parses, and every surface scenario has facts', () => {
    const plan = parsePlan(readFileSync(join(QA, 'ui-verify-surfaces.json'), 'utf-8'), { pageSource: 'vercel-preview' });
    const scenarios = plan.flatMap(r => r.states.map(s => s.surface)).filter(Boolean).map(s => s!.scenario);
    expect(scenarios.sort()).toEqual(Object.keys(facts.scenarios).sort());
    expect(new Set(plan.flatMap(r => r.states.map(s => s.surface!.id)))).toEqual(new Set([MISSION_SITUATION_SURFACE, VISUAL_REVIEW_SURFACE]));
  });
});

describe('closed PR awaiting replacement confirmation', () => {
  it('R-12: Confirm is captured as confirm_replacement, never merge, and every control declares its operation', () => {
    closedPr('awaiting-confirmation');
    const { evidence, notes } = capture(MISSION_SITUATION_SURFACE, 'closed-pr-awaiting-confirmation');
    const ops = evidence.visible.actions.map(a => [a.operation, a.prominence]);
    expect(ops).toContainEqual(['confirm_replacement', 'primary']);
    expect(ops).toContainEqual(['dismiss_replacement', 'secondary']);
    expect(ops).toContainEqual(['resolve_pr_closure', 'secondary']);
    // The label says "Confirm #41"; the operation is the declared one.
    const confirm = evidence.visible.actions.find(a => a.operation === 'confirm_replacement')!;
    expect(confirm.label).toMatch(/^Confirm #\d+$/);
    expect(evidence.visible.actions.some(a => a.operation === 'merge_pr' || a.operation === 'other')).toBe(false);
    expect(notes.filter(n => n.startsWith('action'))).toEqual([]);
    expect(evidence.coverage).toMatchObject({ renderedText: 'complete', actions: 'complete', runtimeState: 'complete' });
    expect(runUiActionStateCheck(evidence).verdict).toBe('pass');
  });

  it('measures the operational facts as shown: visible blocks, and nothing on the card says it merges', () => {
    closedPr('awaiting-confirmation');
    const { evidence } = capture(MISSION_SITUATION_SURFACE, 'closed-pr-awaiting-confirmation');
    expect(evidence.visible.blocks.map(b => b.role)).toEqual(['heading', 'body']);
    expect(evidence.visible.blocks.every(b => b.disclosure === 'visible')).toBe(true);
    // The reason the replacement is suggested sits in the visible body, not behind a disclosure.
    expect(evidence.visible.blocks[1]!.text).toMatch(/likely superseded by .*#41 \(merged by/);
    // No action and no block offers a merge: the only primary is the confirm.
    expect(evidence.visible.actions.filter(a => a.prominence === 'primary').map(a => a.operation).sort()).toEqual(['confirm_replacement', 'view_detail']);
    expect(evidence.visible.blocks.some(b => /\bmerge (it|the pr|now)\b/i.test(b.text))).toBe(false);
  });

  it('a collapsed operational fact is recorded as collapsed, not as shown', () => {
    closedPr('awaiting-confirmation');
    const body = container.querySelector<HTMLElement>('[data-testid="closed-pr-row"] [data-verify-block="body"]')!;
    body.style.display = 'none';
    const { evidence } = capture(MISSION_SITUATION_SURFACE, 'closed-pr-awaiting-confirmation');
    expect(evidence.visible.blocks.find(b => b.role === 'body')!.disclosure).toBe('collapsed');
    // The PR link inside it collapses with it.
    expect(evidence.visible.actions.find(a => /#41/.test(a.label) && a.operation === 'view_detail')!.disclosure).toBe('collapsed');
  });

  it('the same confirm, captured once the replacement is verified, fails the check', () => {
    closedPr('awaiting-confirmation');
    const { evidence } = capture(MISSION_SITUATION_SURFACE, 'closed-pr-replaced');
    expect(runUiActionStateCheck(evidence)).toMatchObject({ verdict: 'fail', observed: 'verified_replacement_offers_unresolved_closure' });
  });
});

describe('closed PR replaced', () => {
  it('offers no confirm, dismiss or abandon, and passes against verified facts', () => {
    closedPr('replaced');
    const { evidence } = capture(MISSION_SITUATION_SURFACE, 'closed-pr-replaced');
    expect(evidence.visible.actions).toEqual([]);
    expect(evidence.visible.blocks[0]).toMatchObject({ role: 'heading', disclosure: 'visible' });
    expect(runUiActionStateCheck(evidence).verdict).toBe('pass');
  });
});

describe('visual review tray', () => {
  const tray = (phase: 'failed' | 'stalled' | 'boot_failed') => render(
    <VisualReviewTray
      model={buildVisualReviewFixtureModel(phase)}
      actions={{ onRetry: () => {}, onSkip: () => {}, onAnswer: async () => {}, answerOptions: ['I fixed it, try again', 'Skip the visual audit'] }}
    />,
  );

  it('failed and stalled: retry is primary retry_visual_review, skip is secondary skip_visual_review', () => {
    for (const phase of ['failed', 'stalled'] as const) {
      tray(phase);
      const { evidence } = capture(VISUAL_REVIEW_SURFACE, `visual-review-${phase}`);
      expect(evidence.visible.actions.map(a => [a.operation, a.prominence])).toEqual([['retry_visual_review', 'primary'], ['skip_visual_review', 'secondary']]);
      expect(evidence.visible.blocks.map(b => b.role)).toEqual(['status', 'body']);
      expect(runUiActionStateCheck(evidence).verdict).toBe('pass');
    }
  });

  it('boot_failed: the answer buttons answer the question, never read as skip or retry from their labels', () => {
    tray('boot_failed');
    const { evidence } = capture(VISUAL_REVIEW_SURFACE, 'visual-review-boot-failed');
    const answers = evidence.visible.actions.filter(a => a.operation === 'answer_question');
    expect(answers.map(a => a.label)).toEqual(['I fixed it, try again', 'Skip the visual audit', 'Reply']);
    expect(evidence.visible.actions.some(a => a.operation === 'skip_visual_review' || a.operation === 'other')).toBe(false);
  });

  it('fix merged, awaiting recapture: the thumbnail caption says so and the facts say pending, not verified', () => {
    const p = parseVisualReviewFixtureParams(new URLSearchParams('view=fix-merged-tray'));
    render(<VisualReviewTray model={buildVisualReviewFixtureModel(p.phase, p.options)} onReview={() => {}} />);
    const { evidence, notes } = capture(VISUAL_REVIEW_SURFACE, 'visual-review-fix-merged');
    expect(evidence.visible.blocks.some(b => b.role === 'label' && /Fix merged/i.test(b.text))).toBe(true);
    expect(evidence.visible.actions.every(a => a.operation === 'view_detail')).toBe(true);
    expect(notes.filter(n => n.startsWith('action'))).toEqual([]);
    expect(runUiActionStateCheck(evidence).verdict).toBe('pass');
  });
});
