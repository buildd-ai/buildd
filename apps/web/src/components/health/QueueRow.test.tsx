import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import QueueRow, { type QueueRowProps } from './QueueRow';

const base: QueueRowProps = { title: 'Queue settings page', reason: 'dependency', blockedBy: 'Export job', age: '1h 4m', href: '/t/1' };
const render = (over: Partial<QueueRowProps> = {}) => renderToStaticMarkup(<QueueRow {...base} {...over} />);

describe('QueueRow', () => {
  it('shows exactly one reason badge, in the catalog word', () => {
    for (const [reason, word] of [['lane', 'Lane'], ['limit', 'Limit'], ['dependency', 'Dependency']] as const) {
      const html = render({ reason });
      expect(html.match(/data-testid="queue-reason"/g)?.length).toBe(1);
      expect(html).toContain(`>${word}</span>`);
    }
  });

  it('keeps the claim route text verbatim as Blocked by (AC-3)', () => {
    expect(render({ reason: 'lane', blockedBy: 'Schema lane · 3rd' })).toContain('Schema lane · 3rd');
    expect(render()).toContain('Export job');
  });

  it('tells reasons apart without colour: each badge has its own marker shape', () => {
    expect(render({ reason: 'lane' })).not.toMatch(/rotate-45|rounded-full/);
    expect(render({ reason: 'limit' })).toContain('rotate-45');
    expect(render({ reason: 'dependency' })).toContain('rounded-full');
  });

  it('draws the status dot only when given one', () => {
    expect(render()).not.toContain('queue-blocked-by-dot');
    expect(render({ blockedByDot: 'running' })).toContain('queue-blocked-by-dot');
  });

  it('is a link with title and age, wide on desktop and two lines on a phone', () => {
    const phone = render({ layout: 'phone' });
    const wide = render({ layout: 'desktop', mission: null });
    expect(phone).toMatch(/^<a[^>]*href="\/t\/1"/);
    expect(phone).toContain('data-layout="phone"');
    expect(wide).toContain('data-layout="desktop"');
    expect(wide).toContain('standalone');
    for (const html of [phone, wide]) expect(html).toContain('1h 4m');
  });
});
