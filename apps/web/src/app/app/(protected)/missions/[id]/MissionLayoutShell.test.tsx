/**
 * Board · Flow · Feed: one layout mounted at a time, tabs in the header.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionLayoutShell, { MissionBoardHeader, MissionLayoutTabs } from './MissionLayoutShell';

const T = Date.UTC(2026, 0, 1);
const slots = {
  board: <div data-testid="slot-board"><MissionLayoutTabs /></div>,
  flow: <div data-testid="slot-flow" />,
  feed: <div data-testid="slot-feed" />,
};

describe('MissionLayoutShell', () => {
  it('mounts only the initial layout', () => {
    const html = renderToStaticMarkup(<MissionLayoutShell initial="flow" {...slots} />);
    expect(html).toContain('data-testid="slot-flow"');
    expect(html).not.toContain('data-testid="slot-board"');
    expect(html).not.toContain('data-testid="slot-feed"');
    expect(html).toContain('data-layout="flow"');
  });

  it('the tabs mark the current layout', () => {
    const html = renderToStaticMarkup(<MissionLayoutShell initial="board" {...slots} />);
    expect(html).toMatch(/aria-selected="true" data-layout="board"/);
    expect(html).toMatch(/aria-selected="false" data-layout="flow"/);
  });

  it('tabs outside the shell render nothing', () => {
    expect(renderToStaticMarkup(<MissionLayoutTabs />)).toBe('');
  });
});

describe('MissionBoardHeader', () => {
  const base = {
    back: { label: 'Missions', href: '/app/missions' },
    title: 'Example mission',
    chip: { label: 'RUNNING', cls: 'text-status-success' },
    serverNow: T + 11 * 60_000 + 50_000,
    startedAt: T,
  };

  it('reads T+ elapsed while running', () => {
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} goal="Do the example thing." />);
    expect(html).toContain('T+ ');
    expect(html).toContain('11:50');
    expect(html).toContain('Do the example thing.');
  });

  it('reads took once complete, in readable units', () => {
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} endedAt={T + 37 * 60_000} activeMs={36 * 60_000} />);
    expect(html).toContain('took ');
    expect(html).toContain('36m');
  });

  it('names work and open time apart when a mission stayed open for weeks', () => {
    const DAY = 86_400_000;
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} endedAt={T + 35 * DAY + 3_600_000} activeMs={40 * 60_000} />);
    const clock = html.split('data-testid="mission-clock"')[1]?.split('</span>')[0] ?? '';
    expect(clock).toContain('40m');
    expect(clock).toContain('of work');
    expect(clock).toContain('open');
    expect(clock).toContain('35d');
    expect(html).not.toMatch(/\d{3,}:\d{2}:\d{2}/);
  });

  it('stops ticking H:MM:SS once a running mission is over a day old', () => {
    const DAY = 86_400_000;
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} serverNow={T + 3 * DAY} activeMs={50 * 60_000} />);
    const clock = html.split('data-testid="mission-clock"')[1]?.split('</span>')[0] ?? '';
    expect(clock).toContain('50m');
    expect(clock).toContain('3d');
    expect(clock).not.toContain('T+');
  });

  it('shows the full description behind a Description control, not a truncated preamble', () => {
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} goal="Retry failed webhooks with backoff." description={<p>Full text</p>} />);
    expect(html).toContain('Retry failed webhooks with backoff.');
    expect(html).toContain('data-testid="mission-description-open"');
  });

  it('clamps a long goal line below md too, so the strip stays on the first screen', () => {
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} goal={'A long goal. '.repeat(80)} description={<p>Full text</p>} />);
    const cls = html.match(/<p data-testid="mission-goal-line"[^>]*? class="([^"]*)"/)?.[1] ?? '';
    expect(cls.split(' ')).toContain('max-md:line-clamp-3');
    expect(cls.split(' ')).toContain('md:truncate');
    expect(html).toContain('data-testid="mission-description-open"');
  });
});
