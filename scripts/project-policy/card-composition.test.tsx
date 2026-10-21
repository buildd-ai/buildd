/** Read-only snapshots of real card components in synthetic states, not live bug evidence. */
import { expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
const { default: ClosedPrResolution } = await import('../../apps/web/src/components/missions/ClosedPrResolution');
const { default: VisualReviewTray } = await import('../../apps/web/src/components/visual-review/VisualReviewTray');
const { buildVisualReviewFixtureModel } = await import('../../apps/web/src/lib/visual-review-model.fixtures');
const { WaitingOnYouReviewCard } = await import('../../apps/web/src/components/WaitingOnYouReviewCard');
const requireWeb = createRequire(resolve(import.meta.dir, '../../apps/web/package.json'));
const { GlobalRegistrator } = requireWeb('@happy-dom/global-registrator') as typeof import('../../apps/web/node_modules/@happy-dom/global-registrator');
GlobalRegistrator.register({ url: 'http://localhost/fixture' });

function snapshot(id: string, element: React.ReactElement, facts: Record<string, unknown>) {
  const html = renderToStaticMarkup(element);
  const root = document.createElement('div');
  root.innerHTML = html;
  // SSR knows native hidden/disclosure state, not CSS, viewport layout or runtime effects.
  const shown = (el: Element) => {
    if (el.closest('[hidden],[aria-hidden="true"]')) return false;
    const details = el.closest('details:not([open])');
    return !details || el.tagName === 'SUMMARY' || !!el.closest('summary');
  };
  const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const blocks = [...root.querySelectorAll('p,h1,h2,h3,button,a,summary')].filter(shown)
    .map(el => ({ tag: el.tagName.toLowerCase(), text: text(el), disabled: el.hasAttribute('disabled') }));
  const buttons = blocks.filter(b => b.tag === 'button');
  const textNodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pieces: string[] = [];
  while (textNodes.nextNode()) {
    const node = textNodes.currentNode;
    if (node.parentElement && shown(node.parentElement) && node.textContent?.trim()) pieces.push(node.textContent.trim());
  }
  const visibleText = pieces.join(' ').replace(/\s+/g, ' ');
  const words = visibleText.split(/\s+/).filter(Boolean).length;
  const result = { id, facts, visibleText, blocks, buttons, words, html, limits: 'SSR composition only. Synthetic state, not a live screenshot or an app-wide count. Native hidden/disclosure state respected; CSS/runtime visibility unverified. Metrics are review cues, not pass/fail thresholds.' };
  return result;
}

it('captures whole closed-PR and visual-review compositions rather than isolated literals', async () => {
  const rows = [
    snapshot('closed-suggestion', <ClosedPrResolution missionId="fixture-mission" items={[{ taskId: 'fixture-task', prNumber: 12,
      suggestion: { repo: 'example/project', prNumber: 34, prUrl: 'https://example.invalid/pr/34', signal: 'sibling_task', score: 0.6, why: 'merged by another task' } }]} />,
      { prState: 'closed', supersession: 'candidate-only', actionMeaning: 'Confirm records that work shipped elsewhere; it does not merge the closed PR.' }),
    snapshot('closed-no-suggestion', <ClosedPrResolution missionId="fixture-mission" items={[{ taskId: 'fixture-task', prNumber: 12 }]} />,
      { prState: 'closed', supersession: 'not-recorded' }),
    ...(['failed', 'stalled', 'boot_failed'] as const).map(phase => snapshot(`visual-${phase}`,
      <VisualReviewTray model={buildVisualReviewFixtureModel(phase)} actions={{ onRetry() {}, onSkip() {}, onAnswer() {},
        answerOptions: ['I fixed it, try again', 'Skip the visual audit'] }} />, { phase, source: 'existing model fixture' })),
    snapshot('review-card-stale-input', <WaitingOnYouReviewCard item={{ subjectKey: 'fixture-pr', chip: 'REVIEW', prNumber: 12,
      prUrl: 'https://example.invalid/pr/12', taskTitle: 'Example change', workspaceId: 'fixture-workspace', workspaceName: 'Example' }} />,
      { externallyKnownPrState: 'closed', serverCardInput: 'still requests review', syntheticBoundaryProbe: true,
        limitation: 'Deliberately stale caller input; does not establish that the current production loader emits this card.' }),
  ];
  expect(rows[0].buttons.map(b => b.text)).toEqual(['Confirm #34', 'Not this', 'Mark abandoned']);
  expect(rows[1].buttons.map(b => b.text)).toEqual(['Mark abandoned']);
  const failed = rows.find(r => r.id === 'visual-failed')!;
  expect(failed.blocks.some(b => b.tag === 'p' && /Retry it, or skip/.test(b.text))).toBe(true);
  expect(failed.buttons.map(b => b.text)).toContain('Retry the audit');
  expect(rows.find(r => r.id === 'visual-boot_failed')!.blocks.some(b => /dev server exited/.test(b.text))).toBe(true);
  expect(rows[5].buttons.some(b => b.text === 'Merge')).toBe(true);
  if (process.env.COPY_CARD_REPORT) await Bun.write(process.env.COPY_CARD_REPORT, JSON.stringify({ provenance: 'Real components, synthetic state; no product changes or network calls.', rows }, null, 2));
});
