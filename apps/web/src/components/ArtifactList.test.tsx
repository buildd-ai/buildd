import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ArtifactList from './ArtifactList';

/**
 * The default view is the review queue. These assertions are about the FIRST
 * render (server markup), which is what a human actually lands on — the toggle
 * to everything else is a client interaction and is covered by the predicate
 * tests in `@/lib/artifact-prominence`.
 */

type Item = Parameters<typeof ArtifactList>[0]['artifacts'][number];

const item = (over: Partial<Item> & { id: string; type: string }): Item => ({
  title: `title-${over.id}`,
  content: null,
  shareToken: null,
  metadata: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  taskTitle: null,
  taskId: null,
  workspaceName: null,
  ...over,
});

const MIXED: Item[] = [
  item({ id: 'report', type: 'report' }),
  item({ id: 'shot', type: 'screenshot' }),
  item({ id: 'plan', type: 'impl_plan' }),
  item({ id: 'mission-plan', type: 'impl_plan', missionId: 'm1' }),
  item({ id: 'shared-shot', type: 'screenshot', visibility: 'public', shareToken: 'tok' }),
];

function render(props: Partial<Parameters<typeof ArtifactList>[0]> = {}) {
  return renderToStaticMarkup(
    <ArtifactList artifacts={MIXED} baseUrl="https://buildd.test" {...props} />,
  );
}

describe('ArtifactList review scope', () => {
  it('defaults to review-worthy artifacts when showReviewFilter is set', () => {
    const html = render({ showReviewFilter: true });
    expect(html).toContain('title-report');
    expect(html).toContain('title-mission-plan');
    expect(html).toContain('title-shared-shot');
    // Incidental: present in the data, absent from the default view.
    expect(html).not.toContain('title-shot"');
    expect(html).not.toContain('title-plan"');
  });

  it('renders a scope toggle carrying both counts', () => {
    const html = render({ showReviewFilter: true });
    expect(html).toContain('data-testid="artifact-scope-review"');
    expect(html).toContain('data-testid="artifact-scope-all"');
    expect(html).toContain('For review');
    expect(html).toContain('All artifacts');
    // 3 review-worthy of 5 total.
    expect(html).toMatch(/For review<span[^>]*>3</);
    expect(html).toMatch(/All artifacts<span[^>]*>5</);
  });

  it('marks the review segment as the pressed one', () => {
    const html = render({ showReviewFilter: true });
    expect(html).toMatch(/aria-pressed="true" data-testid="artifact-scope-review"/);
    expect(html).toMatch(/aria-pressed="false" data-testid="artifact-scope-all"/);
  });

  it('shows everything and no toggle when the caller opts out', () => {
    const html = render();
    expect(html).not.toContain('artifact-scope-review');
    for (const i of MIXED) expect(html).toContain(`title-${i.id}`);
  });

  it('counts type pills within the active scope, not the whole list', () => {
    // `report` is review-worthy (1) and `screenshot` is not, so the
    // screenshot pill must not appear at all in the review scope.
    const html = render({ showReviewFilter: true });
    expect(html).not.toContain('>Screenshot');
  });
});

describe('ArtifactList server-driven scope (paged callers)', () => {
  // /app/artifacts loads one page, already filtered in SQL. The toggle must
  // navigate (so the server re-queries the other scope) and show the SQL
  // counts, not counts of whatever page happens to be loaded.
  const REVIEW_ONLY = MIXED.filter(i => i.id !== 'shot' && i.id !== 'plan');
  const serverScope = {
    scope: 'review' as const,
    reviewCount: 40,
    totalCount: 90,
    hrefs: { review: '/app/artifacts?scope=review', all: '/app/artifacts?scope=all' },
    partial: true,
  };

  it('renders toggle segments as links carrying the SQL counts', () => {
    const html = render({ artifacts: REVIEW_ONLY, serverScope });
    const tag = (testid: string) => html.match(new RegExp(`<a [^>]*data-testid="${testid}"[^>]*>`))?.[0] ?? '';
    expect(tag('artifact-scope-all')).toContain('href="/app/artifacts?scope=all"');
    expect(tag('artifact-scope-review')).toContain('aria-current="page"');
    expect(tag('artifact-scope-all')).not.toContain('aria-current');
    expect(html).toMatch(/For review<span[^>]*>40</);
    expect(html).toMatch(/All artifacts<span[^>]*>90</);
  });

  it('does not re-filter server-scoped rows on the client', () => {
    const html = render({ artifacts: MIXED, serverScope: { ...serverScope, scope: 'all' } });
    for (const i of MIXED) expect(html).toContain(`title-${i.id}`);
  });

  it('offers a link to all artifacts, not "No artifacts yet", when the review page is empty', () => {
    const html = render({ artifacts: [], serverScope });
    expect(html).not.toContain('No artifacts yet');
    expect(html).toContain('Nothing waiting for review.');
    expect(html).toContain('href="/app/artifacts?scope=all"');
  });

  it('says search covers only the loaded rows when the page is partial', () => {
    const many = Array.from({ length: 5 }, (_, n) => item({ id: `r${n}`, type: 'report' }));
    const html = render({ artifacts: many, serverScope });
    expect(html).toContain('data-testid="artifact-search-partial"');
  });
});
