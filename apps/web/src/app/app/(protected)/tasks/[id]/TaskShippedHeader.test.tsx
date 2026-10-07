import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskShippedBody, TaskShippedTitle } from './TaskShippedHeader';
import { buildTaskShippedView, type BuildTaskShippedViewInput } from './task-shipped-header';

const LEDE = 'A finished task now opens on a plain sentence about what changed.';
const PR_URL = 'https://github.com/acme/web/pull/416';

const view = (over: Partial<BuildTaskShippedViewInput> = {}) => buildTaskShippedView({
  taskStatus: 'completed',
  taskMode: 'execution',
  conventionalType: 'feat',
  category: null,
  record: { version: 1, lede: LEDE, changeType: 'frontend', offPlan: [], prNumber: 416, computedAt: '' },
  summary: 'Raw handoff with `paths` in it.',
  summarySource: 'agent',
  pr: { url: PR_URL, number: 416, lifecycle: 'ci_green', merged: false },
  heroShots: [],
  errorTraceCount: 0,
  inRelease: false,
  ...over,
})!;

describe('TaskShippedTitle', () => {
  it('renders the eyebrow, the plain title and the status chips', () => {
    const html = renderToStaticMarkup(<TaskShippedTitle view={view()} title="Completed task page leads with what shipped" status="completed" />);
    expect(html).toContain('What shipped · Feature');
    expect(html).toContain('Completed task page leads with what shipped');
    expect(html).toContain('Done');
    expect(html).toContain('Ready to merge');
    expect(html).toContain('data-testid="task-header-status"');
  });
});

describe('TaskShippedBody', () => {
  it('open PR: lede card, then one full-width Review & merge with the checks line under it', () => {
    const html = renderToStaticMarkup(<TaskShippedBody view={view()} />);
    expect(html).toContain(LEDE);
    expect(html).toContain('On screen');
    expect(html).toContain('Your move');
    expect(html).toContain('Review &amp; merge');
    expect(html).toContain('w-full md:w-auto');
    expect(html).toContain('Checks passing · PR #416');
    expect(html.indexOf('task-shipped-lede-card')).toBeLessThan(html.indexOf('task-shipped-your-move'));
    // The raw handoff is behind the collapsed disclosure, never the headline.
    expect(html).toContain('Technical summary');
    expect(html).not.toContain('Raw handoff');
  });

  it('merged with shots: no action, the shots link to the artifact viewer', () => {
    const html = renderToStaticMarkup(<TaskShippedBody view={view({
      pr: { url: PR_URL, number: 416, lifecycle: 'merged', merged: true },
      heroShots: [{ artifactId: 'shot-1', route: '/app/tasks/:id', viewport: 'mobile', verdict: 'ok' }],
    })} />);
    expect(html).not.toContain('Your move');
    expect(html).toContain('Merged · PR #416');
    expect(html).toContain('href="?artifact=shot-1"');
  });

  it('recovered error: a quiet row linking to the traces', () => {
    const html = renderToStaticMarkup(<TaskShippedBody view={view({ errorTraceCount: 1 })} />);
    expect(html).toContain('One hiccup, already handled');
    expect(html).toContain('href="#agent-error-traces"');
    expect(html).not.toContain('status-error');
  });

  it('no lede: no lede card; the title stands alone', () => {
    const html = renderToStaticMarkup(<TaskShippedBody view={view({ record: null })} />);
    expect(html).not.toContain('task-shipped-lede-card');
    expect(html).toContain('data-variant="title-only"');
    expect(html).toContain('Technical summary');
  });

  it('run details sit behind their own disclosure', () => {
    const html = renderToStaticMarkup(<TaskShippedBody view={view()} runDetails={[{ label: 'Turns', value: '42' }]} />);
    expect(html).toContain('Run details');
    expect(html).not.toContain('42');
  });
});
