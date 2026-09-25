/**
 * VisualReviewStrip (docs/design/visual-qa-auditor.md, "Where the screenshots
 * show"): the thumbnail strip inside the Delivery step. Static render.
 * Illustrative fixtures only.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { toVisualShots } from '@/lib/mission-visual-review';
import VisualReviewStrip from './VisualReviewStrip';

const shot = (id: string, route: string, viewport: string, verdict: string) => ({
  id,
  type: 'screenshot',
  createdAt: '2026-03-10T10:00:00.000Z',
  metadata: { qa: { runKey: 'run-a', route, viewport, verdict, finding: `Finding for ${id}.` } },
});

const shots = toVisualShots([
  shot('a', '/app/tasks', 'mobile', 'ok'),
  shot('b', '/app/tasks', 'desktop', 'issue'),
  shot('c', '/app/missions', 'mobile', 'unsure'),
  shot('d', '/app/missions', 'desktop', 'issue'),
]);

describe('VisualReviewStrip', () => {
  const html = renderToStaticMarkup(<VisualReviewStrip shots={shots} missionId="m1" />);

  it('renders a count line with issues and unsure', () => {
    expect(html).toContain('data-testid="visual-review-strip"');
    const count = html.match(/data-testid="visual-review-count"[^>]*>([\s\S]*?)<\/p>/)![1].replace(/<[^>]+>/g, '');
    expect(count).toBe('4 shots · 2 issues · 1 unsure');
  });

  it('renders one thumb per shot with its verdict and a status-coloured square dot', () => {
    const thumbs = [...html.matchAll(/data-testid="visual-review-thumb" data-verdict="([a-z]+)"/g)].map(m => m[1]);
    expect(thumbs).toEqual(['ok', 'issue', 'unsure', 'issue']);
    expect(html).toContain('bg-status-success');
    expect(html).toContain('bg-status-error');
    expect(html).toContain('bg-status-info');
  });

  it('captions each thumb with its route and viewport', () => {
    expect(html).toContain('/app/tasks · mobile');
    expect(html).toContain('/app/missions · desktop');
  });

  it('loads images lazily through the access-checked download route, with no share token', () => {
    const srcs = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map(m => m[1]);
    expect(srcs).toEqual(['/api/artifacts/a/download', '/api/artifacts/b/download', '/api/artifacts/c/download', '/api/artifacts/d/download']);
    expect(html).not.toContain('token=');
    for (const img of html.match(/<img[^>]*>/g)!) expect(img).toContain('loading="lazy"');
  });

  it('stays square: no rounded utilities', () => {
    expect(html).not.toMatch(/rounded-/);
  });

  it('renders the lightbox closed', () => {
    expect(html).not.toContain('role="dialog"');
  });

  it('says so when the run has no shots', () => {
    const empty = renderToStaticMarkup(<VisualReviewStrip shots={[]} missionId="m1" />);
    expect(empty).toContain('No screenshots yet');
    expect(empty).not.toContain('data-testid="visual-review-thumb"');
  });

  it('counts an all-ok run without verdict clauses', () => {
    const ok = renderToStaticMarkup(<VisualReviewStrip shots={shots.slice(0, 1)} missionId="m1" />);
    const count = ok.match(/data-testid="visual-review-count"[^>]*>([\s\S]*?)<\/p>/)![1].replace(/<[^>]+>/g, '');
    expect(count).toBe('1 shot · all ok');
  });
});
