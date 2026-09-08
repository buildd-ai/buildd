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

describe('ReleaseRow layout', () => {
  // The row is an <a> (inline by default) wrapping block-level children. `.card`
  // is a components-layer class that sets background/border but NO display, so
  // without an explicit display utility the whole list rendered as collapsed
  // inline boxes with text spilling out of them.
  it('gives the anchor an explicit block display', () => {
    const className = render().match(/<a [^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(className).toContain('card');
    expect(className.split(/\s+/)).toContain('block');
  });

  // `bg-surface-hover` is not a token in tailwind.config.ts (only surface-1..4),
  // so the hover state it named never existed. `.card-interactive` is the
  // defined hover treatment for cards.
  it('uses the defined card hover treatment, not an undefined surface token', () => {
    const className = render().match(/<a [^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(className).not.toContain('surface-hover');
    expect(className).toContain('card-interactive');
  });
});
