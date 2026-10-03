/**
 * VisualReviewLine is the one place phase copy is rendered: every phase shows
 * `describeVisualPhase`'s label (and its detail in the full variant), with no
 * dash placeholders, and one dot per current screen. Illustrative fixtures.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { VISUAL_REVIEW_PHASES } from '@buildd/shared';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';
import { describeVisualPhase } from '@/lib/visual-review-model';
import VisualReviewLine, { visualPhaseTone, visualReviewPhaseCopy } from './VisualReviewLine';

const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

describe('VisualReviewLine', () => {
  it('renders the copy for every phase', () => {
    for (const phase of VISUAL_REVIEW_PHASES) {
      const m = buildVisualReviewFixtureModel(phase);
      const copy = describeVisualPhase(m);
      const full = text(renderToStaticMarkup(<VisualReviewLine model={m} variant="full" />));
      expect(full).toContain(copy.label);
      expect(full).toContain(copy.detail);
      expect(full).not.toMatch(/[—]/);
      const compact = renderToStaticMarkup(<VisualReviewLine model={m} />);
      expect(text(compact)).toContain(copy.label);
      expect(compact).not.toContain('visual-review-line-detail');
      expect(compact).toContain(`data-phase="${phase}"`);
    }
  });

  it('words each needs_you reason', () => {
    const q = buildVisualReviewFixtureModel('needs_you', { needsYou: 'question' });
    expect(text(renderToStaticMarkup(<VisualReviewLine model={q} variant="full" />))).toContain('Which account should I sign in with');
    const cap = buildVisualReviewFixtureModel('needs_you', { needsYou: 'round_cap' });
    expect(text(renderToStaticMarkup(<VisualReviewLine model={cap} />))).toContain('Your call');
    const unsure = buildVisualReviewFixtureModel('needs_you', { needsYou: 'unsure' });
    expect(text(renderToStaticMarkup(<VisualReviewLine model={unsure} />))).toContain('1 to review');
  });

  it('draws one dot per screen: hollow when it awaits you, ticked when decided, grey once its fix merged', () => {
    const m = buildVisualReviewFixtureModel('needs_you', { scenario: 'deck' });
    const html = renderToStaticMarkup(<VisualReviewLine model={m} />);
    expect((html.match(/data-dot=/g) ?? []).length).toBe(m.cells.length);
    // Hollow = the "N to review" count: unsure screens. A fix check waits in the deck instead.
    expect(m.summary.fixChecks).toBe(1);
    expect((html.match(/data-dot="awaiting"/g) ?? []).length).toBe(m.summary.awaitingHuman);
    expect(m.summary.awaitingCapture).toBe(1);
    expect((html.match(/data-dot="fix_merged"/g) ?? []).length).toBe(1);
    expect((html.match(/data-dot="decided"/g) ?? []).length).toBe(m.summary.reviewed);
    expect(renderToStaticMarkup(<VisualReviewLine model={buildVisualReviewFixtureModel('queued')} />)).not.toContain('data-dot=');
  });

  it('re-exports the copy; needs you is the accent, broken is red, blocked is a warning', () => {
    expect(visualReviewPhaseCopy).toBe(describeVisualPhase);
    expect(visualPhaseTone('needs_you')).toBe('needs');
    expect(visualPhaseTone('no_browser_runner')).toBe('blocked');
    expect(visualPhaseTone('boot_failed')).toBe('attention');
    expect(visualPhaseTone('failed')).toBe('attention');
    expect(visualPhaseTone('stalled')).toBe('attention');
    const needs = renderToStaticMarkup(<VisualReviewLine model={buildVisualReviewFixtureModel('needs_you')} />);
    expect(needs).toContain('text-accent-text');
    expect(needs).not.toContain('text-status-error');
    expect(visualPhaseTone('reviewed')).toBe('done');
    expect(visualPhaseTone('off')).toBe('quiet');
  });
});
