/**
 * The auditor's task page: screenshots with a valid `metadata.qa` render as a
 * Tray (grouped by route, the verdict on each thumbnail) instead of one bare
 * card each; every other artifact keeps its card. With the mission's review
 * model, one Tray per round, latest first. Static render; illustrative fixtures.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskArtifactsSection from './TaskArtifactsSection';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';
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

  it('groups the shots by route and variant, each with its verdict', () => {
    expect(html.match(/data-testid="visual-review-route"/g)!.length).toBe(2);
    expect(text).toContain('/invoices/:id');
    expect(text).toContain('eur');
    expect(text).toContain('jpy');
    expect(html).toContain('data-verdict="issue"');
    expect(html).toContain('data-verdict="ok"');
  });

  it('keeps other artifacts as cards and counts everything', () => {
    expect(html.match(/data-testid="artifact-card"/g)!.length).toBe(1);
    expect(text).toContain('Artifacts (3)');
  });

  it('thumbnails load through the access-checked download route', () => {
    expect(html).toContain('src="/api/artifacts/a/download"');
  });
});

describe('TaskArtifactsSection, an audit round with the mission model', () => {
  const model = buildVisualReviewFixtureModel('reviewed');
  const round2 = renderToStaticMarkup(
    <TaskArtifactsSection artifacts={[report]} taskId="fixture-audit-2" baseUrl="https://example.test" missionId="fixture-mission" visual={{ round: 2, model }} />,
  );

  it('shows one Tray per round, latest round first, with headers', () => {
    const rounds = [...round2.matchAll(/data-testid="audit-round" data-round="(\d+)"/g)].map(m => Number(m[1]));
    expect(rounds).toEqual([2, 1]);
    const plain = round2.replace(/<[^>]+>/g, ' ');
    expect(plain.indexOf('Round 2')).toBeLessThan(plain.indexOf('Round 1'));
  });

  it('a round-1 audit shows only its own round, never the later re-shoot', () => {
    const html1 = renderToStaticMarkup(
      <TaskArtifactsSection artifacts={[report]} taskId="fixture-audit-1" baseUrl="https://example.test" missionId="fixture-mission" visual={{ round: 1, model }} />,
    );
    expect([...html1.matchAll(/data-testid="audit-round" data-round="(\d+)"/g)].map(m => m[1])).toEqual(['1']);
    expect(html1).not.toContain('Round 2');
  });
});
