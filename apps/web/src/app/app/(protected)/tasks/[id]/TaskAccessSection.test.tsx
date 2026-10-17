import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskAccessSection from './TaskAccessSection';
import type { AccessItem } from '@/lib/agent-capabilities/access-log';

const item = (o: Partial<AccessItem>): AccessItem => ({
  at: '2026-10-05T12:03:00.000Z', lastAt: '2026-10-05T12:03:00.000Z', count: 1,
  capability: 'github.repo_grant', label: 'GitHub repo access', decision: 'allowed',
  reason: null, target: 'acme/widget', expiresAt: null, workerId: 'w-1', source: 'run', grantId: null, pending: false, ...o,
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
      item({ source: 'grant', capability: 'pr.merge', label: 'Merge PR', decision: 'refused', reason: "not this task's PR", target: 'PR #7' }),
    ]);
    expect(html).toContain('aria-expanded="true"');
    expect(text(html)).toContain('1 refused');
    expect(text(html)).toContain('GitHub repo access · acme/widget');
    expect(text(html)).toContain('renewed 2×');
    expect(text(html)).toContain("refused · not this task's PR");
    expect(html).toContain('data-decision="refused"');
  });

  it('shows the buildd token as an active run credential with renewals behind a toggle, not as an approval', () => {
    const html = render([item({ capability: 'task_token.mint', label: 'buildd token', target: 'worker level', count: 3, expiresAt: '2026-10-05T15:19:00.000Z' })]);
    const open = render([item({ capability: 'task_token.mint', label: 'buildd token', target: 'worker level', count: 3 }), item({ source: 'grant', capability: 'pr.merge', label: 'Merge PR', decision: 'refused', target: 'PR #7' })]);
    expect(open).toContain('data-testid="task-access-run"');
    expect(open).toContain('<details');
    expect(text(open)).toContain('Run credentials');
    expect(text(open)).toContain('Issued by buildd when the run starts; nobody approved it');
    expect(text(open)).toContain('active');
    expect(text(open)).not.toContain('allowed');
    expect(html).not.toContain('task-access-item');
  });

  it('links a pending request to the same decision Needs You shows, and opens itself', () => {
    const html = render([item({ source: 'grant', capability: 'capability.request', label: 'Capability request', decision: 'refused', target: null, grantId: 'g-9', pending: true })]);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('href="/app/settings/apps?request=g-9#agent-access"');
    expect(text(html)).toContain('1 waiting on a person');
    expect(html).not.toContain('task-access-refused');
    expect(html).toContain('data-decision="pending"');
  });
});
