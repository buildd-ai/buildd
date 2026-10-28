import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import IdleAlert, { QUEUE_HREF } from './IdleAlert';

const html = (props: Partial<Parameters<typeof IdleAlert>[0]> = {}) =>
  renderToStaticMarkup(<IdleAlert idleSlots={2} queuedTasks={3} cause="no reviewer runner" {...props} />);

describe('IdleAlert', () => {
  it('says N idle slots, N tasks could start, with the cause', () => {
    const out = html();
    expect(out).toContain('2 idle slots, 3 tasks could start.');
    expect(out).toContain('no reviewer runner');
  });

  it('uses singular forms', () => {
    expect(html({ idleSlots: 1, queuedTasks: 1 })).toContain('1 idle slot, 1 task could start.');
  });

  it('renders nothing when idle slots have no startable work', () => {
    expect(html({ queuedTasks: 0 })).toBe('');
  });

  it('renders nothing when no slot is idle', () => {
    expect(html({ idleSlots: 0 })).toBe('');
  });

  it('links to the Queue by default', () => {
    expect(QUEUE_HREF).toBe('/app/health/queue');
    expect(html()).toContain(`href="${QUEUE_HREF}"`);
  });

  it('honours an explicit href and carries no hard-coded colours', () => {
    const out = html({ href: '/app/health/queue?tab=queued' });
    expect(out).toContain('href="/app/health/queue?tab=queued"');
    expect(out).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
