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

  it('inline density: no empty span when kind/roleSlug/taskType are all null (PR #2456 regression)', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ density: 'inline', kind: null, roleSlug: null, taskType: null })} />,
    );
    expect(html).not.toMatch(/<span[^>]*><\/span>/); // no empty spans
  });
});

// Activity rows showed the PR number twice (the "DONE #N" chip and a
// "PR #N↗" link beside it), and PR-review tasks titled "PR #N: …" said it a
// third time in the title.
describe('TaskCard — PR number shown once', () => {
  const pr = { prUrl: 'https://github.com/example-org/example-repo/pull/42', prNumber: 42, prLifecycleStatus: 'merged' };

  for (const density of ['row', 'full'] as const) {
    it(`${density} density: the chip carries #N and the link does not repeat it`, () => {
      const html = renderToStaticMarkup(<TaskCard {...baseProps({ density, ...pr })} />);
      expect(html).toContain('>#42</span>');
      expect(html).not.toContain('>PR #');
      expect(html).toContain(`href="${pr.prUrl}"`);
      expect(html).toContain('aria-label="Open PR #42"');
    });

    it(`${density} density: strips a leading "PR #N:" from the title when the chip shows #N`, () => {
      const html = renderToStaticMarkup(
        <TaskCard {...baseProps({ density, title: 'PR #42: fix(ui): tighten spacing', ...pr })} />,
      );
      expect(html).toContain('>fix(ui): tighten spacing<');
      expect(html).not.toContain('>PR #42: fix(ui)');
    });
  }

  it('keeps the title prefix when the chip does not show that number', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ title: 'PR #7: review the other one' })} />,
    );
    expect(html).toContain('>PR #7: review the other one<');
  });

  it('keeps the "PR #N" link text when no chip shows the number (running, no PR stage)', () => {
    const html = renderToStaticMarkup(
      <TaskCard {...baseProps({ taskStatus: 'in_progress', workerStatus: 'running', prUrl: pr.prUrl, prNumber: 42 })} />,
    );
    expect(html).toContain('PR #42');
  });
});
