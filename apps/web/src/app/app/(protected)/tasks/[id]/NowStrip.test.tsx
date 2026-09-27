import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import NowStrip from './NowStrip';

// Regression (demo reshoot, live task step): the "%" beside the big progress
// number rendered above it. It was a <sup> with `align-top`, and Tailwind's
// preflight also gives <sup> `position: relative; top: -0.5em`, so the two
// offsets stacked and lifted the sign clear of the digits. The sign is now a
// plain flex child aligned to the digits' top edge.
describe('NowStrip progress number', () => {
  const html = renderToStaticMarkup(
    <NowStrip now={{ headline: 'PDF footnote', pct: 45, detail: null, updatedTs: null, steps: [] }} nowMs={0} />,
  );
  const pct = html.match(/<div data-testid="worker-now-pct"[^>]*>([\s\S]*?)<\/div>/);

  it('renders the percent sign without <sup>', () => {
    expect(pct).not.toBeNull();
    expect(pct![1]).not.toContain('<sup');
    expect(pct![1]).toMatch(/45<\/span><span[^>]*>%<\/span>/);
  });

  it('lays the number and the sign out side by side', () => {
    expect(pct![0]).toMatch(/class="[^"]*\bflex\b[^"]*\bitems-start\b/);
  });
});

// Regression (UX review, running task at 390px): six uppercase labels with
// 1.5px tracking in six equal columns ran into each other ("STARTEDREAD",
// "COMMITPR"). Phones drop the tracking; desktop keeps it.
describe('NowStrip step rail on a phone', () => {
  const steps = ['started', 'read', 'edit', 'commit', 'pr', 'done'].map((k, i) => ({
    key: k, label: k, state: i < 3 ? 'done' : i === 3 ? 'current' : 'todo', at: null,
  }));
  const html = renderToStaticMarkup(
    <NowStrip now={{ headline: 'x', pct: 45, detail: null, updatedTs: null, steps } as any} nowMs={0} />,
  );
  const items = [...html.matchAll(/<li [^>]*class="([^"]*)"/g)].map(m => m[1]);

  it('renders one label per step', () => {
    expect(items).toHaveLength(6);
  });

  it('tracks labels only from md up', () => {
    for (const cls of items) {
      expect(cls).toMatch(/(^|\s)tracking-normal(\s|$)/);
      expect(cls).toMatch(/(^|\s)md:tracking-\[1\.5px\](\s|$)/);
      expect(cls).not.toMatch(/(^|\s)tracking-\[1\.5px\]/);
    }
  });
});
