import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Criteria from './Criteria';
import MissionRow from './MissionRow';

describe('MissionRow', () => {
  it('title, small strip and one state line', () => {
    const html = renderToStaticMarkup(
      <MissionRow href="/app/missions/x" title="Delivery UX" strip={['landed', 'landed', 'review', 'running', 'blocked']} state="review" stat="2 of 5 merged" eta="~4:55 PM" next="03 lands when CI passes" />,
    );
    expect(html).toContain('href="/app/missions/x"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('Auditing · 2 of 5 merged · ~4:55 PM');
    expect(html).toContain('Next');
  });

  it('a waiting decision leads, and a slip shows only when given', () => {
    const html = renderToStaticMarkup(<MissionRow href="#" title="M" strip={['needs_you']} state="needs_you" decide="Decide: add the staging credential" />);
    expect(html).toContain('! Decide: add the staging credential');
    expect(html).not.toContain('later than');
  });

  it('wraps a long title to at most three lines, between words, never mid-word', () => {
    const title = 'Workflow kernel: authoritative task to PR to review to merge state across every surface';
    const html = renderToStaticMarkup(<MissionRow href="#" title={title} strip={[]} />);
    const span = html.match(/<span[^>]*title="Workflow kernel[^"]*"[^>]*>/)?.[0] ?? '';
    expect(span).toContain('line-clamp-3');
    expect(span).toContain('[overflow-wrap:break-word]');
    expect(span).not.toContain('anywhere');
    expect(span).not.toContain('truncate');
  });
});

describe('Criteria', () => {
  it('counts what is met and marks each row', () => {
    const html = renderToStaticMarkup(
      <Criteria items={[{ ok: true, text: 'Design spec attached', value: 'found' }, { ok: false, text: 'All PRs merged', value: '2/7' }]} />,
    );
    expect(html).toContain('Goal · 1 of 2 criteria');
    expect(html).toContain('✓');
    expect(html).toContain('○');
    expect(html).toContain('2/7');
  });
});
