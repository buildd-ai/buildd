/**
 * Overview · Flow · History: one layout mounted at a time, no tab bar (spec
 * d25d923d R-3); the ⋯ menu switches layouts through `useMissionLayout`.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionLayoutShell, { MissionBoardHeader, useMissionLayout } from './MissionLayoutShell';

const T = Date.UTC(2026, 0, 1);

/** A test switcher: what the ⋯ menu's History and Flow rows do. */
function Switch() {
  const ctx = useMissionLayout();
  if (!ctx) return null;
  return <p data-testid="switch" data-layout={ctx.layout}>{ctx.layout}</p>;
}

const slots = {
  board: <div data-testid="slot-board"><Switch /></div>,
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

  it('draws no tab bar; the layout is read through useMissionLayout (R-3)', () => {
    const html = renderToStaticMarkup(<MissionLayoutShell initial="board" {...slots} />);
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).toContain('data-testid="switch" data-layout="board"');
    // Flow replaced Lanes: there is no Lanes layout.
    expect(html).not.toContain('data-layout="lanes"');
  });

  it('the switcher outside the shell renders nothing', () => {
    expect(renderToStaticMarkup(<Switch />)).toBe('');
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

  it('shows the goal as one sentence with the rest behind More, not a truncated preamble (R-3)', () => {
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} goal="Retry failed webhooks with backoff." description={<p>Full text</p>} />);
    expect(html).toContain('Retry failed webhooks with backoff.');
    expect(html).toMatch(/data-testid="mission-description-open"[^>]*>(?:<[^>]+>)*More/);
    expect(html).not.toMatch(/data-testid="mission-description-open"[^>]*>(?:<[^>]+>)*Description/);
  });

  it('clamps a long goal line to two lines below md, so the bar stays on the first screen', () => {
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} goal={'A long goal. '.repeat(80)} description={<p>Full text</p>} />);
    const cls = html.match(/<p data-testid="mission-goal-line"[^>]*? class="([^"]*)"/)?.[1] ?? '';
    expect(cls.split(' ')).toContain('max-md:line-clamp-2');
    expect(html).toContain('data-testid="mission-description-open"');
  });

  it('carries one spec line under the goal and keeps the reading width (R-3, R-21)', () => {
    const html = renderToStaticMarkup(<MissionBoardHeader {...base} goal="Goal." spec={<p data-testid="spec">Spec Cloud runner</p>}><div data-testid="content" /></MissionBoardHeader>);
    const at = (s: string) => html.indexOf(s);
    expect(at('data-testid="mission-goal-line"')).toBeLessThan(at('data-testid="mission-spec-line"'));
    expect(at('data-testid="mission-spec-line"')).toBeLessThan(at('data-testid="content"'));
    expect(html).toContain('max-w-[var(--content-measure)]');
    expect(html).not.toContain('max-w-[1120px]');
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

  it('back and the one ⋯ menu share the first row; the title, state line and content follow, with no tab bar', () => {
    const html = board();
    const at = (s: string) => html.indexOf(s);
    expect(at('‹ Missions')).toBeGreaterThan(-1);
    expect(at('data-testid="mission-header-actions"')).toBeGreaterThan(at('‹ Missions'));
    expect(at('<h1')).toBeGreaterThan(at('data-testid="act"'));
    expect(at('data-testid="mission-state-line"')).toBeGreaterThan(at('<h1'));
    expect(at('data-testid="content"')).toBeGreaterThan(at('data-testid="mission-state-line"'));
    expect(html).not.toContain('data-testid="mission-layout-tabs"');
    expect(html).not.toContain('role="tablist"');
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
    expect(chip).not.toMatch(/upper[c]ase/);
    expect(board()).toMatch(/data-testid="mission-state-chip"[^>]*>(?:<span[^>]*><\/span>)?Running<\/span>/);
  });

  it('the panel names the layout it shows', () => {
    const html = board();
    expect(html).toMatch(/id="mission-layout-panel" data-layout-panel="board"/);
    expect(html.indexOf('data-testid="content"')).toBeGreaterThan(html.indexOf('id="mission-layout-panel"'));
  });
});
