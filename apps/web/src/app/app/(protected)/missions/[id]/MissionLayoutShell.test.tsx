/**
 * Overview · Flow · History: one layout mounted at a time, tabs in the header.
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
    expect(html).toMatch(/aria-selected="true"[^>]*data-layout="board"/);
    expect(html).toMatch(/aria-selected="false"[^>]*data-layout="flow"/);
    expect(html).toMatch(/aria-selected="false"[^>]*data-layout="feed"/);
    expect(html).toContain('>Overview<');
    expect(html).toContain('>Flow<');
    expect(html).toContain('>History<');
    // Flow replaced Lanes: there is no Lanes tab.
    expect(html).not.toContain('data-layout="lanes"');
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

  it('clamps a long goal line to two lines below md too, so the strip stays on the first screen', () => {
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} goal={'A long goal. '.repeat(80)} description={<p>Full text</p>} />);
    const cls = html.match(/<p data-testid="mission-goal-line"[^>]*? class="([^"]*)"/)?.[1] ?? '';
    expect(cls.split(' ')).toContain('max-md:line-clamp-2');
    expect(cls.split(' ')).toContain('md:truncate');
    expect(html).toContain('data-testid="mission-description-open"');
  });
});

describe('MissionBoardHeader, compact', () => {
  const base = {
    back: { label: 'Missions', href: '/app/missions' },
    title: 'A mission title long enough to need more than one line on a phone',
    chip: { label: 'RUNNING', cls: 'text-accent-text' },
    serverNow: T + 60_000,
    startedAt: T,
  };
  const board = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(
    <MissionLayoutShell
      initial="board"
      board={<MissionBoardHeader {...base} {...extra} actions={<button type="button" data-testid="act">More</button>}><div data-testid="content" /></MissionBoardHeader>}
      flow={<div />}
      feed={<div />}
    />,
  );

  it('back and the actions share the first row; the title, state line and tabs follow in that order', () => {
    const html = board();
    const at = (s: string) => html.indexOf(s);
    expect(at('‹ Missions')).toBeGreaterThan(-1);
    expect(at('data-testid="mission-header-actions"')).toBeGreaterThan(at('‹ Missions'));
    expect(at('<h1')).toBeGreaterThan(at('data-testid="act"'));
    expect(at('data-testid="mission-state-line"')).toBeGreaterThan(at('<h1'));
    expect(at('data-testid="mission-layout-tabs"')).toBeGreaterThan(at('data-testid="mission-state-line"'));
  });

  it('the title is sans, wraps, and is clamped (never truncated to one line), with its full text as a tooltip', () => {
    const h1 = board().match(/<h1[^>]*>/)?.[0] ?? '';
    expect(h1).not.toContain('font-mono');
    expect(h1).not.toContain('truncate');
    expect(h1).toContain('line-clamp-3');
    expect(h1).toContain(`title="${base.title}"`);
  });

  it('the state chip is a quiet line: no frame, no oversized caps', () => {
    const chip = board().match(/<span data-testid="mission-state-chip"[^>]*>/)?.[0] ?? '';
    expect(chip).not.toContain('border-[1.5px]');
    expect(chip).toContain('text-meta');
    expect(chip).not.toContain('font-mono');
    expect(chip).not.toContain('uppercase');
    expect(board()).toMatch(/data-testid="mission-state-chip"[^>]*>(?:<span[^>]*><\/span>)?Running<\/span>/);
  });

  it('tabs: one tab stop, each controls the panel, and the panel names the selected tab', () => {
    const html = board();
    const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
    expect(tabs).toHaveLength(3);
    expect(tabs.filter(t => t.includes('tabindex="0"'))).toHaveLength(1);
    for (const t of tabs) expect(t).toContain('aria-controls="mission-layout-panel"');
    expect(html).toMatch(/id="mission-layout-panel" role="tabpanel" aria-labelledby="mission-tab-board"/);
    expect(html.indexOf('data-testid="content"')).toBeGreaterThan(html.indexOf('role="tabpanel"'));
  });
});
