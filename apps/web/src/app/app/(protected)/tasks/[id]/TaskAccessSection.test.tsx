import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskAccessSection from './TaskAccessSection';
import type { AccessItem } from '@/lib/agent-capabilities/access-log';

const item = (o: Partial<AccessItem>): AccessItem => ({
  at: '2026-10-05T12:03:00.000Z', lastAt: '2026-10-05T12:03:00.000Z', count: 1,
  capability: 'github.repo_grant', label: 'GitHub repo access', decision: 'allowed',
  reason: null, target: 'acme/widget', expiresAt: null, workerId: 'w-1', ...o,
});
const render = (items: AccessItem[]) => renderToStaticMarkup(<TaskAccessSection items={items} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('TaskAccessSection', () => {
  it('renders nothing for a task with no recorded access', () => {
    expect(render([])).toBe('');
  });

  it('stays collapsed when nothing was refused', () => {
    const html = render([item({ count: 3 })]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('task-access-item');
  });

  it('opens on its own and flags the count when something was refused', () => {
    const html = render([
      item({ count: 3 }),
      item({ capability: 'pr.merge', label: 'Merge PR', decision: 'refused', reason: "not this task's PR", target: 'PR #7' }),
    ]);
    expect(html).toContain('aria-expanded="true"');
    expect(text(html)).toContain('1 refused');
    expect(text(html)).toContain('GitHub repo access · acme/widget · renewed 2×');
    expect(text(html)).toContain("refused · not this task's PR");
    expect(html).toContain('data-decision="refused"');
  });
});
