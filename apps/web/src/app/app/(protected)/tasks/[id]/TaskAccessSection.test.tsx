import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskAccessSection from './TaskAccessSection';
import type { AccessItem } from '@/lib/agent-capabilities/access-log';

const item = (o: Partial<AccessItem>): AccessItem => ({
  at: '2026-10-05T12:03:00.000Z', lastAt: '2026-10-05T12:03:00.000Z', count: 1,
  capability: 'github.repo_grant', label: 'GitHub repo access', decision: 'allowed',
  reason: null, target: 'acme/widget', expiresAt: null, workerId: 'w-1', source: 'run', grantId: null, pending: false, closed: null, ...o,
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

  it('a request closed because its task ended reads as closed: no Review link, not waiting, not refused', () => {
    const closed = item({ source: 'grant', capability: 'capability.request', label: 'Capability request', decision: 'refused', target: null, grantId: 'g-9', pending: false, closed: 'the task ended' });
    // On its own it is past history: the section stays folded.
    expect(render([closed])).toContain('aria-expanded="false"');
    const html = render([closed, item({ source: 'grant', capability: 'pr.merge', label: 'Merge PR', decision: 'refused', target: 'PR #7' })]);
    expect(text(html)).toContain('1 refused');
    expect(html).not.toContain('task-access-review');
    expect(html).not.toContain('/app/settings/apps?request=');
    expect(html).not.toContain('task-access-waiting');
    expect(html).toContain('data-decision="closed"');
    expect(text(html)).toContain('closed · the task ended');
  });

  it('a database query shows its SQL, row count and duration to the owner', () => {
    const q = { capability: 'database.query', label: 'Database query', source: 'grant' as const, target: 'production database (read-only)' };
    const html = render([
      item({ ...q, query: { sql: 'select id from tasks', sqlTruncated: false, rowCount: 200, durationMs: 31, truncated: true } }),
      item({ ...q, decision: 'refused', reason: 'a table outside the read allowlist', query: { sql: 'select * from secrets', sqlTruncated: false, rowCount: null, durationMs: null, truncated: false } }),
    ]);
    expect(html).toContain('task-access-query');
    expect(text(html)).toContain('select id from tasks');
    expect(text(html)).toContain('200 rows (capped) · 31 ms');
    expect(text(html)).toContain('select * from secrets');
    expect(text(html)).toContain('refused · a table outside the read allowlist');
  });
});
