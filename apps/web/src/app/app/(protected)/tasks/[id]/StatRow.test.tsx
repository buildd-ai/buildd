/**
 * Regression: in the mission sheet's narrow panel on a desktop screen, the
 * stats row laid out five tiles by the viewport's width and truncated every
 * figure ("6:…", "44…"). It lays out by its own container's width.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import StatRow from './StatRow';

describe('StatRow', () => {
  it('sizes its columns by its container, not the viewport', () => {
    const html = renderToStaticMarkup(
      <StatRow elapsed="6:03" turns={9} tokens={44_200} pr={{ url: 'https://github.com/example/app/pull/57', number: 57, state: 'ci_passed' }} filesTouched={0} added={30} removed={4} />,
    );
    expect(html).toMatch(/class="@container[^"]*"><div data-testid="worker-stats"/);
    expect(html).toContain('@xl:grid-cols-5');
    expect(html).not.toMatch(/md:grid-cols-/);
  });
});
