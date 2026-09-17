import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskCard, type TaskCardProps } from './TaskCard';

function baseProps(overrides: Partial<TaskCardProps> = {}): TaskCardProps {
  return {
    id: 'task-1',
    title: 'Do the thing',
    taskStatus: 'completed',
    taskCreatedAt: '2026-08-01T00:00:00.000Z',
    taskUpdatedAt: '2026-08-01T00:00:00.000Z',
    density: 'row',
    ...overrides,
  };
}

describe('TaskCard — ship badge mount (§10.3)', () => {
  it('row density: renders "Force release" badge when release=true', () => {
    const html = renderToStaticMarkup(<TaskCard {...baseProps({ release: 'true' })} />);
    expect(html).toContain('Force release');
  });

  it('row density: renders "Shipped" badge linking to the release when attributed to a healthy release', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ release: 'inherit', shippedReleaseId: 'rel-42' })} />,
    );
    expect(html).toContain('Shipped');
    expect(html).toContain('/app/releases/rel-42');
  });

  it('row density: renders no ship badge for the default inherit/unattributed case (AC-49)', () => {
    const html = renderToStaticMarkup(<TaskCard {...baseProps({ release: 'inherit' })} />);
    expect(html).not.toContain('Skip release');
    expect(html).not.toContain('Force release');
    expect(html).not.toContain('Shipped');
  });

  it('full density: renders "Skip release" badge when release=false', () => {
    const html = renderToStaticMarkup(<TaskCard {...baseProps({ density: 'full', release: 'false' })} />);
    expect(html).toContain('Skip release');
  });

  it('full density: additive — Force release and Shipped both render', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ density: 'full', release: 'true', shippedReleaseId: 'rel-7' })} />,
    );
    expect(html).toContain('Force release');
    expect(html).toContain('Shipped');
  });
});

// AC-50 — the task rail primitive renders exactly deriveChainPosition's segments;
// no release/ship segment was grafted onto it. Asserted against source: the chain
// strip must not exist for a standalone task (chain.total === 1), and must only
// ever pass through `chain.segments` unmodified.
const cardSource = await Bun.file(new URL('./TaskCard.tsx', import.meta.url)).text();

describe('TaskCard — AC-50: no release/ship segment on the rail', () => {
  it('ChainStrip passes through chain.segments unmodified — no appended segment', () => {
    const chainStrip = cardSource.slice(
      cardSource.indexOf('function ChainStrip('),
      cardSource.indexOf('// ─── Intensity tier'),
    );
    expect(chainStrip).toContain('segments={chain.segments}');
    expect(chainStrip).not.toMatch(/segments={\[?\.\.\.chain\.segments/);
    expect(chainStrip).not.toContain('release');
    expect(chainStrip).not.toContain('ship');
  });
});

describe('TaskCard — attempt-type badge (retry/review/review-retry)', () => {
  it('taskType=retry renders the ↻ badge regardless of roleSlug', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ taskType: 'retry', roleSlug: 'builder' })} />,
    );
    expect(html).toContain('↻');
    expect(html).toContain('CI Retry');
  });

  it('taskType=review renders the ⬡ badge regardless of roleSlug', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ taskType: 'review', roleSlug: 'builder' })} />,
    );
    expect(html).toContain('⬡');
    expect(html).toContain('Review');
  });

  it('taskType=review-retry renders the ↻ badge and distinguishes from review', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ taskType: 'review-retry', roleSlug: 'builder' })} />,
    );
    expect(html).toContain('↻');
    expect(html).toContain('Review Retry');
  });

  it('review and review-retry render distinct badges (never the same)', () => {
    const reviewHtml = renderToStaticMarkup(
      <TaskCard {...baseProps({ taskType: 'review' })} />,
    );
    const reviewRetryHtml = renderToStaticMarkup(
      <TaskCard {...baseProps({ taskType: 'review-retry' })} />,
    );
    expect(reviewHtml).toContain('⬡');
    expect(reviewHtml).toContain('Review');
    expect(reviewRetryHtml).toContain('Review Retry');
    expect(reviewHtml).not.toContain('Review Retry');
  });

  it('retry renders even with no kind/roleSlug set (non-empty badge)', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ taskType: 'retry', kind: null, roleSlug: null })} />,
    );
    expect(html).toContain('↻');
    expect(html).not.toMatch(/<span[^>]*><\/span>/); // no empty spans
  });
});

describe('TaskCard — work-kind badge fallback', () => {
  it('without taskType, renders work-kind glyph from kind prop', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ kind: 'engineering', taskType: null })} />,
    );
    expect(html).toContain('◆');
  });

  it('without taskType or kind, renders work-kind glyph from roleSlug', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ kind: null, roleSlug: 'builder', taskType: null })} />,
    );
    expect(html).toContain('◆');
  });

  it('without taskType, kind, or roleSlug, renders no badge', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ kind: null, roleSlug: null, taskType: null })} />,
    );
    expect(html).not.toContain('◆');
    expect(html).not.toContain('▲');
  });
});
