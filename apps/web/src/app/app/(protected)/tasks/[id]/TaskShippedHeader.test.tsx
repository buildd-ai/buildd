import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskShippedBody, TaskShippedDetails, TaskShippedTitle } from './TaskShippedHeader';
import { buildTaskShippedView, type BuildTaskShippedViewInput } from './task-shipped-header';

const LEDE = 'A finished task now opens on a plain sentence about what changed.';

const view = (over: Partial<BuildTaskShippedViewInput> = {}) => buildTaskShippedView({
  taskStatus: 'completed',
  taskMode: 'execution',
  conventionalType: 'feat',
  category: null,
  record: { version: 1, lede: LEDE, changeType: 'frontend', offPlan: [], prNumber: 416, computedAt: '' },
  summary: 'Raw handoff with `paths` in it.',
  summarySource: 'agent',
  heroShots: [],
  ...over,
})!;

describe('TaskShippedTitle', () => {
  it('renders the eyebrow and the plain title, and no status chips', () => {
    const html = renderToStaticMarkup(<TaskShippedTitle view={view()} title="Completed task page leads with what shipped" />);
    expect(html).toContain('What shipped · Feature');
    expect(html).toContain('Completed task page leads with what shipped');
    expect(html).not.toContain('Done');
    expect(html).not.toContain('Ready to merge');
  });
});

describe('TaskShippedBody', () => {
  it('the lede card only: no Your move, no hiccup row, never the raw handoff', () => {
    const html = renderToStaticMarkup(<TaskShippedBody view={view()} />);
    expect(html).toContain(LEDE);
    expect(html).toContain('On screen');
    expect(html).not.toContain('Your move');
    expect(html).not.toContain('hiccup');
    expect(html).not.toContain('Raw handoff');
  });

  it('shots link to the artifact viewer', () => {
    const html = renderToStaticMarkup(<TaskShippedBody view={view({
      heroShots: [{ artifactId: 'shot-1', route: '/app/tasks/:id', viewport: 'mobile', verdict: 'ok' }],
    })} />);
    expect(html).toContain('href="?artifact=shot-1"');
  });

  it('no lede: no lede card', () => {
    const html = renderToStaticMarkup(<TaskShippedBody view={view({ record: null })} />);
    expect(html).not.toContain('task-shipped-lede-card');
    expect(html).toContain('data-variant="title-only"');
  });
});

describe('TaskShippedDetails', () => {
  it('technical summary and run details sit behind their own collapsed disclosures', () => {
    const html = renderToStaticMarkup(<TaskShippedDetails view={view()} runDetails={[{ label: 'Turns', value: '42' }]} />);
    expect(html).toContain('Technical summary');
    expect(html).not.toContain('Raw handoff');
    expect(html).toContain('Run details');
    expect(html).not.toContain('42');
  });

  it('extra run material (workers, scope, plan) goes inside Run details', () => {
    const html = renderToStaticMarkup(<TaskShippedDetails view={view({ summary: null })}><p>worker list</p></TaskShippedDetails>);
    expect(html).toContain('Run details');
    expect(html).not.toContain('Technical summary');
  });
});
