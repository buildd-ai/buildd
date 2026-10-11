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
      commitRangeUrl="https://github.com/o/r/compare/aaaaaaa...bbbbbbb"
      metrics={{ taskCount: 2, missionCount: 1 }}
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
    const html = render({ release: supersededRelease, supersededByVersion: 'v1.2.3', supersededByReleaseId: 'r1' });
    expect(html).toContain('Superseded by');
    expect(html).toContain('>v1.2.3</a>');
    expect(html).not.toContain('superseded by release r1');
  });

  it('is a grey neutral pill, never a red Failed', () => {
    const html = render({ release: supersededRelease, supersededByVersion: 'v1.2.3', supersededByReleaseId: 'r1' });
    expect(html).toContain('data-state="queued"');
    expect(html).toContain('data-tone="q"');
    expect(html).not.toContain('data-tone="bad"');
    expect(html).not.toContain('Failed');
    expect(html).not.toContain('text-status-error');
  });

  it('links to the newer release when superseded', () => {
    const html = render({ release: supersededRelease, supersededByVersion: 'v1.2.3', supersededByReleaseId: 'r1' });
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
    const html = render({ release: { ...supersededRelease, failureReason: 'Deployment failed' } });
    expect(html).toContain('Deployment failed');
    expect(html).toContain('data-tone="bad"');
    expect(html).not.toContain('data-state="queued"');
  });
});

describe('ReleaseRow content', () => {
  it('titles the row with the version and states it with a StatePill', () => {
    const html = render();
    expect(html).toMatch(/<h2[^>]*>v1\.2\.3<\/h2>/);
    expect(html).toContain('data-state="landed"');
    expect(html).toContain('>Healthy');
  });

  it('shows the workspace only when it is given (a list spanning several)', () => {
    expect(render()).not.toContain('demo-workspace');
    expect(render({ workspaceName: 'demo-workspace' })).toContain('demo-workspace');
  });

  it('has no archetype badge, no Run link and no caps tracked labels', () => {
    const html = render();
    expect(html).not.toMatch(/>\s*Gated\s*</i);
    expect(html).not.toContain('Run →');
    expect(html).not.toContain('actions/runs/1');
    expect(html).not.toMatch(/upper[c]ase/);
  });

  it('keeps times, commits, compare link and counts on one meta line', () => {
    const html = render();
    const meta = html.match(/<p[^>]*data-testid="release-meta"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
    expect(meta).toContain('3 commits');
    expect(meta).toContain('aaaaaaa...bbbbbbb');
    expect(meta).toContain('2 tasks');
    expect(meta).toContain('1 mission');
  });

  it('prints no raw release id when there is no version', () => {
    const html = render({ release: { ...release, id: '0f0e0d0c-0b0a-4908-8706-050403020100', version: null } });
    const visible = html.replace(/<[^>]+>/g, ' ');
    expect(visible).not.toContain('0f0e0d0c');
    expect(visible).toContain('Unversioned release');
  });
});

describe('ReleaseRow layout', () => {
  // History is L1: a hairline row, not a card.
  it('is an L1 hairline row, not a card', () => {
    const html = render();
    expect(html).not.toMatch(/class="card\b/);
    expect(html).toContain('border-b');
  });

  it('drops the hairline when framed by the next-release card', () => {
    expect(render({ bare: true })).not.toContain('border-b');
  });

  // The row carries its own outbound links (the commit range). Nesting <a>
  // inside <a> is invalid HTML that the parser splits into sibling rows.
  it('never nests an anchor inside another anchor', () => {
    expect(maxAnchorDepth(render())).toBe(1);
  });

  // Whole-row navigation is an overlay link; outbound anchors sit above it.
  it('keeps the row clickable via an overlay link, with outbound links above it', () => {
    const html = render();
    expect(html).toMatch(/<a[^>]*class="absolute inset-0[^"]*"/);
    expect(html).toContain('aria-label="Release v1.2.3"');
    const tag = html.match(/<a[^>]*compare\/aaaaaaa\.\.\.bbbbbbb[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('relative');
  });
});
