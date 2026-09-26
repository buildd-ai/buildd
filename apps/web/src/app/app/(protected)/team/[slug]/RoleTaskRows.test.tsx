import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecentTaskRow, CurrentTaskCard } from './RoleTaskRows';

/**
 * A PR link used to sit inside the row's <Link>. An <a> inside an <a> is
 * invalid markup: the HTML parser closes the outer anchor early, so the
 * server HTML and the client tree disagree and React throws a hydration
 * error. The row stays fully clickable via a stretched link instead.
 */
function hasNestedAnchor(html: string): boolean {
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)a\b/g)) {
    if (m[1]) depth--;
    else if (++depth > 1) return true;
  }
  return false;
}

// Illustrative fixtures only.
const task = { id: 't-1', title: 'Example task', status: 'completed' };

describe('role detail task rows', () => {
  it('the detector catches a nested anchor', () => {
    expect(hasNestedAnchor('<a href="/x"><span></span><a href="/y">PR</a></a>')).toBe(true);
    expect(hasNestedAnchor('<div><a href="/x">x</a><a href="/y">y</a></div>')).toBe(false);
  });

  it('recent task row with a PR renders no nested anchors', () => {
    const html = renderToStaticMarkup(
      <RecentTaskRow task={task} dotClass="bg-status-success" createdAgo="2h ago" prNumber={12} prUrl="https://example.com/pr/12" />,
    );
    expect(html).toContain('PR #12');
    expect(html).toContain('href="/app/tasks/t-1"');
    expect(hasNestedAnchor(html)).toBe(false);
  });

  it('recent task row without a PR URL still shows the PR number', () => {
    const html = renderToStaticMarkup(
      <RecentTaskRow task={task} dotClass="bg-status-success" createdAgo="2h ago" prNumber={7} prUrl={null} />,
    );
    expect(html).toContain('PR #7');
    expect(hasNestedAnchor(html)).toBe(false);
  });

  it('current task card with a PR renders no nested anchors', () => {
    const html = renderToStaticMarkup(
      <CurrentTaskCard
        task={{ id: 't-2', title: 'Running task', workspaceName: 'Example WS', missionTitle: 'Example mission' }}
        startedAgo="5m ago"
        prNumber={3}
        prUrl="https://example.com/pr/3"
      />,
    );
    expect(html).toContain('PR #3');
    expect(html).toContain('href="/app/tasks/t-2"');
    expect(hasNestedAnchor(html)).toBe(false);
  });
});
