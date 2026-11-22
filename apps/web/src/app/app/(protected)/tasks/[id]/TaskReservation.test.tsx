import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskReservation, TaskClientFrom } from './TaskReservation';

const now = new Date('2026-11-22T12:00:00Z');
const ctx = (mins: number) => ({ reservedBy: { accountId: 'a1', at: '2026-11-22T11:40:00Z', expiresAt: new Date(now.getTime() + mins * 60_000).toISOString() } });

describe('TaskReservation — who holds a pending task and until when', () => {
  it('names the holder, the absolute time and the time left', () => {
    const html = renderToStaticMarkup(<TaskReservation context={ctx(14)} status="pending" holderName="max-laptop" now={now} />);
    expect(html).toContain('data-testid="task-reservation"');
    expect(html).toContain('max-laptop');
    expect(html).toContain('12:14 UTC');
    expect(html).toContain('for 14 more min');
  });
  it('never prints the raw account id when the name is unknown', () => {
    const html = renderToStaticMarkup(<TaskReservation context={ctx(14)} status="pending" holderName={null} now={now} />);
    expect(html).not.toContain('a1');
    expect(html).toContain('another account');
  });
  it('renders nothing once the reservation lapsed', () => {
    expect(renderToStaticMarkup(<TaskReservation context={ctx(-3)} status="pending" holderName="max-laptop" now={now} />)).toBe('');
  });
  it('renders nothing once the task is claimed', () => {
    expect(renderToStaticMarkup(<TaskReservation context={ctx(14)} status="in_progress" holderName="max-laptop" now={now} />)).toBe('');
  });
});

describe('TaskClientFrom — the filing client', () => {
  it('says "from T3 Code" for the bridge\'s marker', () => {
    const html = renderToStaticMarkup(<TaskClientFrom context={{ client: { kind: 'acp', name: 'T3 Code' } }} />);
    expect(html).toContain('data-testid="task-client"');
    expect(html).toContain('from T3 Code');
  });
  it('renders nothing for a task with no marker, however its title reads', () => {
    expect(renderToStaticMarkup(<TaskClientFrom context={{ title: 'from T3 Code' }} />)).toBe('');
  });
});
