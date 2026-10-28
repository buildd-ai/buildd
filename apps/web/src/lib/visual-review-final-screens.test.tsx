import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { VisualReviewCell, VisualReviewCellEntry, VisualReviewModel, VisualQaVerdict } from '@buildd/shared';
import { finalScreens } from './visual-review-final-screens';
import MissionFinalScreens from '@/app/app/(protected)/missions/[id]/MissionFinalScreens';

function entry(id: string, round: number, createdAt: string, o: { theme?: string; state?: string; verdict?: VisualQaVerdict; fixTaskId?: string } = {}): VisualReviewCellEntry {
  return {
    round,
    shot: { id, auditTaskId: null, round, createdAt, src: `/api/artifacts/${id}/download`, qa: { runKey: '', route: '/a', viewport: 'mobile', finding: 'f', verdict: o.verdict ?? 'ok', theme: o.theme, state: o.state, fixTaskId: o.fixTaskId } },
    agentVerdict: o.verdict ?? 'ok',
    finding: 'f',
    fixTask: null,
    review: null,
  };
}
function cell(route: string, viewport: 'mobile' | 'desktop', entries: VisualReviewCellEntry[]): VisualReviewCell {
  return { key: `${route}|${viewport}|`, route, viewport, variant: null, current: entries[entries.length - 1], history: entries, effectiveVerdict: 'ok', marker: 'awaiting', needsHuman: false } as VisualReviewCell;
}
const model = (cells: VisualReviewCell[]) => ({ cells }) as Pick<VisualReviewModel, 'cells'>;

describe('finalScreens', () => {
  it('keeps the newest shot per route, viewport and theme across rounds', () => {
    const out = finalScreens(model([
      cell('/a', 'mobile', [entry('old-light', 1, '2026-10-01T00:00:00Z', { theme: 'light' }), entry('new-light', 2, '2026-10-02T00:00:00Z', { theme: 'light' }), entry('dark', 1, '2026-10-01T00:00:00Z', { theme: 'dark' })]),
      cell('/a', 'desktop', [entry('desk', 1, '2026-10-01T00:00:00Z')]),
    ]));
    expect(out.map(s => s.shotId).sort()).toEqual(['dark', 'desk', 'new-light']);
  });

  it('is empty for no model, and keeps a dialog state apart from the page', () => {
    expect(finalScreens(null)).toEqual([]);
    const out = finalScreens(model([cell('/a', 'mobile', [entry('page', 1, '2026-10-01T00:00:00Z'), entry('dialog', 1, '2026-10-02T00:00:00Z', { state: 'confirm' })])]));
    expect(out).toHaveLength(2);
  });

  it('carries an existing fix link', () => {
    expect(finalScreens(model([cell('/a', 'mobile', [entry('x', 1, '2026-10-01T00:00:00Z', { fixTaskId: 'fix1' })])]))[0].fixTaskId).toBe('fix1');
  });
});

describe('MissionFinalScreens gates nothing', () => {
  const html = (verdict: VisualQaVerdict) =>
    renderToStaticMarkup(<MissionFinalScreens missionId="m1" screens={finalScreens(model([cell('/a', 'mobile', [entry('x', 1, '2026-10-01T00:00:00Z', { verdict })])]))} />);

  it('offers only a per-screen File a fix button, with no form, required or disabled control', () => {
    const out = html('issue');
    expect(out).toContain('File a fix');
    expect(out).not.toContain('<form');
    expect(out).not.toMatch(/ required=/);
    expect(out).not.toMatch(/ disabled=/);
    expect((out.match(/<button/g) ?? []).length).toBe(1);
  });

  it('renders the same whatever the verdict, and renders nothing with no screens', () => {
    expect(html('ok')).toBe(html('issue'));
    expect(renderToStaticMarkup(<MissionFinalScreens missionId="m1" screens={[]} />)).toBe('');
  });
});
