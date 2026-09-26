/**
 * MissionMasthead at its three sizes (docs/design/mission-feed-mobile-continuity.md,
 * "The shared object", W1/W2/W3/W4). The chip is the accessor's chip
 * (`getMissionStateChip` / `deriveMissionStateView`) and the sentence is the
 * accessor's situation: the masthead renders them, it never phrases them.
 * Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { getMissionStateChip } from '@/lib/mission-helpers';
import { deriveMissionStateView } from '@/lib/mission-state-view';
import { buildPulseSegments, type MissionFeedTaskInput } from '@/lib/mission-pulse';
import MissionMasthead, {
  MISSION_MASTHEAD_FOLDED_PX,
  buildPulseCaption,
  nextMastheadFolded,
} from './MissionMasthead';

let clock = Date.UTC(2026, 0, 1);
function t(id: string, over: Partial<MissionFeedTaskInput> = {}): MissionFeedTaskInput {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), ...over };
}
const BUILD = { missionPhaseIndex: 1, missionPhaseLabel: 'BUILD' };
const tasks = [
  t('a', { status: 'completed' }),
  t('b', { ...BUILD, status: 'in_progress', worker: { status: 'running' } }),
  t('c', { ...BUILD }),
];
const segments = buildPulseSegments(tasks);
const view = deriveMissionStateView({ status: 'active', isHeld: false, activeAgents: 1, health: 'NOMINAL' });
const chip = view.chip;

describe('buildPulseCaption', () => {
  it('counts done over total, plus live workers', () => {
    expect(buildPulseCaption(segments, { liveWorkers: 2 })).toBe('1/3 · 2 live');
    expect(buildPulseCaption(segments)).toBe('1/3');
  });

  it('counts through folded phase segments', () => {
    const many: MissionFeedTaskInput[] = [];
    for (let i = 0; i < 41; i++) many.push(t(`x${i}`, { ...BUILD, status: i < 10 ? 'completed' : 'pending' }));
    expect(buildPulseCaption(buildPulseSegments(many))).toBe('10/41');
  });
});

describe('nextMastheadFolded (fold-on-scroll with hysteresis)', () => {
  it('folds past the threshold and only unfolds near the top', () => {
    expect(nextMastheadFolded(false, 10)).toBe(false);
    expect(nextMastheadFolded(false, 80)).toBe(true);
    expect(nextMastheadFolded(true, 40)).toBe(true); // hysteresis band: no flicker
    expect(nextMastheadFolded(true, 4)).toBe(false);
  });
});

describe('size="card" (W1)', () => {
  const html = renderToStaticMarkup(
    <MissionMasthead
      size="card"
      title="Claim loop hardening"
      chip={chip}
      situation={view.situation}
      segments={segments}
      caption="1/3 · 1 live"
      href="/app/missions/m1?from=home"
      primary={{ label: 'Answer: Lease shadow mode', href: '/app/missions/m1?from=home&task=b' }}
    />,
  );

  it('renders title, one chip, the situation line, the card pulse, the caption and one primary line', () => {
    expect(html).toContain('data-testid="mission-masthead"');
    expect(html).toContain('data-size="card"');
    expect(html).toContain('Claim loop hardening');
    expect(html.match(/data-testid="mission-state-chip"/g)).toHaveLength(1);
    expect(html).toContain(`>${chip.label}<`);
    expect(html).toContain('data-testid="mission-situation-line"');
    expect(html).toContain(view.situation.headline);
    expect(html).toContain('data-testid="mission-pulse"');
    expect(html).toContain('data-variant="card"');
    expect(html).toContain('1/3 · 1 live');
    expect(html).toContain('data-testid="mission-masthead-primary"');
    expect(html).toContain('href="/app/missions/m1?from=home&amp;task=b"');
  });

  it('never nests the primary link inside the card link', () => {
    const opens = [...html.matchAll(/<a\s/g)].map(m => m.index!);
    const closes = [...html.matchAll(/<\/a>/g)].map(m => m.index!);
    expect(opens).toHaveLength(2);
    expect(closes).toHaveLength(2);
    // Each link closes before the next opens.
    expect(closes[0]).toBeLessThan(opens[1]);
  });

  it('is not sticky', () => {
    expect(html).not.toContain('sticky');
  });
});

describe('size="sticky" (W2/W3)', () => {
  const html = renderToStaticMarkup(
    <MissionMasthead
      size="sticky"
      title="Claim loop hardening"
      chip={getMissionStateChip('stalled')}
      segments={segments}
      caption="1/3"
      back={{ label: 'Home', href: '/app/home' }}
      verified={<span data-testid="verified-slot">2/3 verified</span>}
    />,
  );

  it('is sticky at top-0 inside <main> (AC-5)', () => {
    const root = html.match(/<[^>]*data-testid="mission-masthead"[^>]*>/)?.[0] ?? '';
    expect(root).toMatch(/class="[^"]*\bsticky\b/);
    expect(root).toMatch(/class="[^"]*\btop-0\b/);
    expect(root).toContain('data-size="sticky"');
    expect(root).toContain('data-folded="false"');
  });

  it('shows back label, title, chip, verified slot and the header pulse on first paint', () => {
    expect(html).toContain('‹ Home');
    expect(html).toContain('href="/app/home"');
    expect(html).toContain('>STALLED<');
    expect(html).toContain('data-testid="verified-slot"');
    expect(html).toContain('data-variant="header"');
  });

  it('exports the folded height token used for row scroll-margin', () => {
    expect(MISSION_MASTHEAD_FOLDED_PX).toBe(84);
  });
});

describe('size="micro" (W4/W6)', () => {
  const html = renderToStaticMarkup(
    <MissionMasthead
      size="micro"
      title="Claim loop hardening"
      chip={chip}
      segments={segments}
      selectedTaskId="b"
      position={{ n: 2, total: 3, phaseLabel: 'BUILD', prevHref: '/app/tasks/a', nextHref: '/app/tasks/c' }}
      href="/app/missions/m1#t-b"
    />,
  );

  it('renders title, chip, context pulse ringed on the task, n / N · phase, and ‹ ›', () => {
    expect(html).toContain('data-size="micro"');
    expect(html).toContain('data-variant="context"');
    expect(html).toMatch(/data-task-id="b"[^>]*data-ringed="true"|data-ringed="true"[^>]*data-task-id="b"/);
    expect(html).toContain('2 / 3 · BUILD');
    expect(html).toContain('data-testid="mission-masthead-prev"');
    expect(html).toContain('href="/app/tasks/a"');
    expect(html).toContain('data-testid="mission-masthead-next"');
    expect(html).toContain('href="/app/tasks/c"');
    expect(html).toContain('href="/app/missions/m1#t-b"');
  });

  it('never squeezes the pulse under the position text (phone: the ringed segment painted over "8 / 12")', () => {
    // Regression: the pulse was `flex-1` beside a `shrink-0` "n / N · phase"
    // span, so a long phase label collapsed it to ~0px and the ringed
    // segment's outline landed on the count. The pulse keeps a floor width
    // and the position text is the one that gives way (truncates).
    const pulse = html.match(/<div[^>]*data-testid="mission-pulse"[^>]*>/)?.[0] ?? '';
    expect(pulse).toContain('flex-[1_0_5rem]');
    const pos = html.match(/<span[^>]*>2 \/ 3 · BUILD<\/span>/)?.[0] ?? '';
    expect(pos).not.toBe('');
    expect(pos).not.toContain('shrink-0');
    expect(pos).toContain('truncate');
    expect(pos).toContain('min-w-0');
  });

  it('gives the title up-link a 44px tap target', () => {
    const up = html.match(/<a[^>]*href="\/app\/missions\/m1#t-b"[^>]*>/)?.[0] ?? '';
    expect(up).toContain('min-h-11');
    expect(up).toContain('items-center');
    expect(html).not.toContain('min-h-[32px]');
  });

  it('renders a disabled step as a disabled button, so its label is announced', () => {
    const first = renderToStaticMarkup(
      <MissionMasthead size="micro" title="M" chip={chip} segments={segments}
        position={{ n: 1, total: 3, phaseLabel: null, prevHref: null, nextHref: '/x' }} />,
    );
    const prev = first.match(/<[^>]*data-testid="mission-masthead-prev"[^>]*>/)?.[0] ?? '';
    expect(prev.startsWith('<button')).toBe(true);
    expect(prev).toContain('disabled=""');
    expect(prev).toContain('aria-label="Previous task"');
  });

  it('disables ‹ at the first task and › at the last', () => {
    const first = renderToStaticMarkup(
      <MissionMasthead size="micro" title="M" chip={chip} segments={segments}
        position={{ n: 1, total: 3, phaseLabel: null, prevHref: null, nextHref: '/x' }} />,
    );
    expect(first).toMatch(/data-testid="mission-masthead-prev"[^>]*aria-disabled="true"/);
    expect(first).toContain('1 / 3');
    expect(first).not.toContain('1 / 3 ·');
  });
});
