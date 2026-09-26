/**
 * The auditor's task page: screenshots with a valid `metadata.qa` render as a
 * thumbnail grid (caption, verdict, finding) instead of one bare card each;
 * every other artifact keeps its card. Static render; illustrative fixtures.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskArtifactsSection from './TaskArtifactsSection';
import type { TaskArtifactItem } from './task-artifact-items';

const shot = (id: string, title: string, viewport: string, verdict = 'ok'): TaskArtifactItem => ({
  id,
  type: 'screenshot',
  title,
  content: null,
  storageKey: `qa/ws-1/${id}/${title}`,
  shareToken: null,
  visibility: 'private',
  metadata: {
    qa: { runKey: 'r1', route: '/invoices/:id', viewport, verdict, finding: `Checked ${title}.` },
    filename: title,
    mimeType: 'image/png',
    sizeBytes: 1000,
  },
  createdAt: `2026-03-04T12:0${id.length}:00.000Z`,
});

const report: TaskArtifactItem = {
  id: 'r', type: 'report', title: 'Notes', content: 'Body', storageKey: null,
  shareToken: null, visibility: 'private', metadata: {}, createdAt: '2026-03-04T12:00:00.000Z',
};

const html = renderToStaticMarkup(
  <TaskArtifactsSection
    artifacts={[shot('a', 'invoices-eur-desktop.png', 'desktop'), shot('bb', 'invoices-jpy-desktop.png', 'desktop', 'issue'), report]}
    taskId="t1"
    baseUrl="https://example.test"
  />,
);
const text = html.replace(/<[^>]+>/g, '\n');

describe('TaskArtifactsSection, audit screenshots', () => {
  it('renders qa screenshots as a thumbnail grid, not cards', () => {
    expect(html).toContain('data-testid="task-visual-shots"');
    expect(html.match(/data-testid="visual-review-thumb"/g)!.length).toBe(2);
    expect(html).not.toContain('data-kind="screenshot"');
  });

  it('captions each shot with route, variant and viewport, and shows its verdict and finding', () => {
    expect(text).toContain('/invoices/:id · eur · desktop');
    expect(text).toContain('/invoices/:id · jpy · desktop');
    expect(html).toContain('data-verdict="issue"');
    expect(text).toContain('Checked invoices-eur-desktop.png.');
  });

  it('keeps other artifacts as cards and counts everything', () => {
    expect(html.match(/data-testid="artifact-card"/g)!.length).toBe(1);
    expect(text).toContain('Artifacts (3)');
  });

  it('thumbnails load through the access-checked download route', () => {
    expect(html).toContain('src="/api/artifacts/a/download"');
  });
});
