/**
 * Board · Lanes · Feed: one layout mounted at a time, tabs in the header.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionLayoutShell, { MissionBoardHeader, MissionLayoutTabs } from './MissionLayoutShell';

const T = Date.UTC(2026, 0, 1);
const slots = {
  board: <div data-testid="slot-board"><MissionLayoutTabs /></div>,
  lanes: <div data-testid="slot-lanes" />,
  feed: <div data-testid="slot-feed" />,
};

describe('MissionLayoutShell', () => {
  it('mounts only the initial layout', () => {
    const html = renderToStaticMarkup(<MissionLayoutShell initial="lanes" {...slots} />);
    expect(html).toContain('data-testid="slot-lanes"');
    expect(html).not.toContain('data-testid="slot-board"');
    expect(html).not.toContain('data-testid="slot-feed"');
    expect(html).toContain('data-layout="lanes"');
  });

  it('the tabs mark the current layout', () => {
    const html = renderToStaticMarkup(<MissionLayoutShell initial="board" {...slots} />);
    expect(html).toMatch(/aria-selected="true" data-layout="board"/);
    expect(html).toMatch(/aria-selected="false" data-layout="lanes"/);
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

  it('reads took once complete', () => {
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} endedAt={T + 37 * 60_000} />);
    expect(html).toContain('took ');
    expect(html).toContain('37:00');
  });
});
