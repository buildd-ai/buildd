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

function render(overrides = {}) {
  return renderToStaticMarkup(
    <ReleaseRow
      release={release}
      workspaceName="demo"
      commitRangeUrl="https://github.com/o/r/compare/aaaaaaa...bbbbbbb"
      metrics={{ taskCount: 2, missionCount: 1 }}
      stateBadge={{ label: 'Healthy', cls: 'text-status-success' }}
      archetypeBadge={{ label: 'Gated', cls: 'text-blue-600' }}
      {...overrides}
    />,
  );
}

const supersededRelease = {
  id: 'r2',
  workspaceId: 'ws1',
  archetype: 'gated',
  state: 'failed',
  dispatchedAt: '2026-09-06T00:00:00.000Z',
  deployedAt: null,
  commitsAheadAtDispatch: 2,
  previousSha: 'cccccccccccc',
  headSha: 'dddddddddddd',
  version: 'v1.2.1',
  runUrl: null,
  failureReason: 'superseded by release r1 (PR #123 merged)',
};

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

describe('ReleaseRow superseded state', () => {
  it('displays "Superseded by vX.Y.Z" for failed releases with superseded failureReason', () => {
    const html = renderToStaticMarkup(
      <ReleaseRow
        release={supersededRelease}
        workspaceName="demo"
        commitRangeUrl="https://github.com/o/r/compare/cccccc...dddddd"
        metrics={{ taskCount: 0, missionCount: 0 }}
        stateBadge={{ label: 'Superseded', cls: 'text-text-muted border-border-default' }}
        archetypeBadge={{ label: 'Gated', cls: 'text-blue-600' }}
        supersededByVersion="v1.2.3"
        supersededByReleaseId="r1"
      />,
    );
    expect(html).toContain('Superseded by');
    expect(html).toContain('>v1.2.3</a>');
    expect(html).not.toContain('superseded by release r1');
  });

  it('uses neutral badge style for superseded releases, not error tone', () => {
    const html = renderToStaticMarkup(
      <ReleaseRow
        release={supersededRelease}
        workspaceName="demo"
        commitRangeUrl="https://github.com/o/r/compare/cccccc...dddddd"
        metrics={{ taskCount: 0, missionCount: 0 }}
        stateBadge={{ label: 'Superseded', cls: 'text-text-muted border-border-default' }}
        archetypeBadge={{ label: 'Gated', cls: 'text-blue-600' }}
        supersededByVersion="v1.2.3"
        supersededByReleaseId="r1"
      />,
    );
    expect(html).toContain('data-state="queued"');
    expect(html).toContain('data-tone="q"');
    expect(html).not.toContain('text-status-error');
  });

  it('links to the newer release when superseded', () => {
    const html = renderToStaticMarkup(
      <ReleaseRow
        release={supersededRelease}
        workspaceName="demo"
        commitRangeUrl="https://github.com/o/r/compare/cccccc...dddddd"
        metrics={{ taskCount: 0, missionCount: 0 }}
        stateBadge={{ label: 'Superseded', cls: 'text-text-muted border-border-default' }}
        archetypeBadge={{ label: 'Gated', cls: 'text-blue-600' }}
        supersededByVersion="v1.2.3"
        supersededByReleaseId="r1"
      />,
    );
    expect(html).toContain('href="/app/releases/r1"');
  });
});

describe('ReleaseRow successor fallbacks', () => {
  it('keeps a neutral linked fallback when the successor version is null', () => {
    const html = render({ release: supersededRelease, supersededByReleaseId: 'r1', supersededByVersion: null });
    expect(html).toContain('data-state="queued"');
    expect(html).toContain('Superseded by');
    expect(html).toContain('href="/app/releases/r1"');
    expect(html).toContain('>a newer release</a>');
    expect(html).not.toContain('superseded by release r1');
    expect(html).not.toContain('text-status-error');
    expect(maxAnchorDepth(html)).toBe(1);
  });

  it('stays neutral when the successor cannot be resolved', () => {
    const html = render({ release: supersededRelease });
    expect(html).toContain('data-state="queued"');
    expect(html).toContain('Superseded');
    expect(html).not.toContain('superseded by release r1');
    expect(html).not.toContain('text-status-error');
  });

  it('preserves the error tone and reason for an ordinary failure', () => {
    const html = render({
      release: { ...supersededRelease, failureReason: 'Deployment failed' },
      stateBadge: { label: 'Failed', cls: 'text-status-error' },
    });
    expect(html).toContain('Deployment failed');
    expect(html).toContain('text-status-error');
    expect(html).not.toContain('data-state="queued"');
  });
});

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

// Mobile QA: "Run →" was a 41x17 text link.
describe('ReleaseRow touch targets', () => {
  it('the Run link is a 44px target below md', () => {
    const link = render().match(/<a\b[^>]*href="https:\/\/github.com\/o\/r\/actions\/runs\/1"[^>]*>/)![0];
    const cls = (link.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);
    expect(cls).toContain('min-h-11');
    expect(cls).toContain('min-w-11');
  });
});
