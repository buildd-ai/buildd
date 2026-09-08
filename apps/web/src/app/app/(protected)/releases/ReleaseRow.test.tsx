import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReleaseRow } from './ReleaseRow';

const release = {
  id: 'r1',
  workspaceId: 'ws1',
  archetype: 'gated',
  state: 'healthy',
  dispatchedAt: '2026-09-07T00:00:00.000Z',
  deployedAt: '2026-09-07T00:05:00.000Z',
  commitsAheadAtDispatch: 3,
  previousSha: 'aaaaaaaaaaaa',
  headSha: 'bbbbbbbbbbbb',
  version: 'v1.2.3',
  runUrl: 'https://github.com/o/r/actions/runs/1',
  failureReason: null,
};

function render() {
  return renderToStaticMarkup(
    <ReleaseRow
      release={release}
      workspaceName="demo"
      commitRangeUrl="https://github.com/o/r/compare/aaaaaaa...bbbbbbb"
      metrics={{ taskCount: 2, missionCount: 1 }}
      stateBadge={{ label: 'Healthy', cls: 'text-status-success' }}
      archetypeBadge={{ label: 'Gated', cls: 'text-blue-600' }}
    />,
  );
}

/** Max <a> nesting depth in the rendered markup. Anything above 1 is invalid HTML. */
function maxAnchorDepth(html: string): number {
  let depth = 0;
  let max = 0;
  for (const m of html.matchAll(/<a[\s>]|<\/a>/g)) {
    if (m[0] === '</a>') depth--;
    else max = Math.max(max, ++depth);
  }
  return max;
}

describe('ReleaseRow layout', () => {
  // `.card` is a components-layer class that sets background/border but NO
  // display. On an inline host (an <a>) the row collapses into inline boxes
  // with the content spilling out, which is how /app/releases rendered. The
  // invariant is that the card host is a block-level element.
  it('puts the card on a block-level host, never on an inline element', () => {
    const html = render();
    const cardTag = html.match(/<(\w+)[^>]*class="card[^"]*"/);
    expect(cardTag?.[1]).toBe('div');
  });

  // `bg-surface-hover` is not a token in tailwind.config.ts (only surface-1..4),
  // so the hover state it named never existed. `.card-interactive` is the
  // defined hover treatment for cards.
  it('uses the defined card hover treatment, not an undefined surface token', () => {
    const html = render();
    expect(html).not.toContain('surface-hover');
    expect(html).toContain('card-interactive');
  });

  // The row carries its own outbound links (commit range, workflow run). While
  // the card itself was a <Link>, those were <a> inside <a> — invalid HTML that
  // the parser's adoption-agency algorithm splits into several sibling cards,
  // painting a card fragment over the workspace name and desyncing the DOM from
  // React's tree (hydration mismatch). `block` alone did not fix that.
  it('never nests an anchor inside another anchor', () => {
    expect(maxAnchorDepth(render())).toBe(1);
  });

  // Whole-card navigation is preserved by an overlay link, and the outbound
  // anchors must sit above it or they become unclickable.
  it('keeps the card clickable via an overlay link, with outbound links above it', () => {
    const html = render();
    expect(html).toMatch(/<a[^>]*class="absolute inset-0[^"]*"/);
    expect(html).toContain('aria-label="Release detail for demo"');
    for (const href of ['compare/aaaaaaa...bbbbbbb', 'actions/runs/1']) {
      const tag = html.match(new RegExp(`<a[^>]*${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`))?.[0] ?? '';
      expect(tag).toContain('relative');
    }
  });

});
