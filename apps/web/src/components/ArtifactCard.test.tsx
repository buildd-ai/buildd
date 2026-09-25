/**
 * Mobile QA: on a phone the date shared the title row, so a title was
 * truncated to a handful of characters. The date lives on the meta line.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ArtifactCard from './ArtifactCard';

const html = renderToStaticMarkup(
  <ArtifactCard
    artifact={{
      id: 'a-1',
      type: 'report',
      title: 'A reasonably long artifact title that needs the width',
      content: 'Body text',
      metadata: {},
      createdAt: '2026-03-04T12:00:00.000Z',
    }}
    onOpen={() => {}}
  />,
);

const mobile = html.slice(html.indexOf('sm:hidden'), html.indexOf('hidden sm:flex'));

describe('ArtifactCard, mobile layout', () => {
  it('keeps the date out of the title row', () => {
    const titleRow = mobile.match(/data-testid="artifact-card-title-row"[\s\S]*?<\/div>/)![0];
    expect(titleRow).toContain('A reasonably long artifact title');
    expect(titleRow).not.toContain('2026');
  });

  it('shows the date on the meta line', () => {
    const meta = mobile.match(/data-testid="artifact-card-meta"[\s\S]*?<\/div>/)![0];
    expect(meta).toContain('Mar 4, 2026');
  });

  it('lets the title wrap to two lines instead of a one-line truncate', () => {
    const title = mobile.match(/<span[^>]*aria-label="A reasonably long[^"]*"[^>]*>/)![0];
    expect(title).toContain('line-clamp-2');
    expect(title).toContain('min-w-0');
  });
});
