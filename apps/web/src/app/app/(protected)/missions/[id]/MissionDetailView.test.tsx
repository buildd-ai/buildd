/**
 * The mission detail composition (docs/design/mission-feed-mobile-continuity.md,
 * W2/W3). AC-1 (order), AC-2 (one list), AC-3 (slot markers), AC-4 (pulse
 * parity on the header), AC-5 (sticky) and the AC-16 page half, rendered with
 * illustrative 3-, 15- and 45-task missions.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import MissionDetailView, { mastheadBack, parseMissionOrigin } from './MissionDetailView';
import MissionDelivery from './MissionDelivery';
import MissionSituationBlock from '@/components/missions/MissionSituationBlock';
import { MISSION_MASTHEAD_FOLDED_PX } from '@/components/missions/MissionMasthead';
import { MISSION_ROW_SCROLL_MARGIN_CLASS } from '@/components/missions/MissionTaskRow';
import { buildDeliverySteps } from '@/lib/mission-delivery';
import { buildPulseSegments, PULSE_FOLD_THRESHOLD, type MissionFeedTaskInput } from '@/lib/mission-pulse';
import { groupTasksByPhase } from '@/lib/flight-strip-nav';
import { foldMissionDeliverables } from '@/lib/mission-pulse';
import { fixtureMission, workTaskIds, FIXTURE_NOW } from './mission-feed.fixtures';

const situation = {
  headline: 'Waiting on you: an agent asked a question.',
  tone: 'warning' as const,
  focus: null,
  nextAction: null,
  alsoOutstanding: [],
  derivedFrom: 'mission.status' as const,
};

function renderMission(tasks: MissionFeedTaskInput[], description?: ReactNode) {
  const segments = buildPulseSegments(tasks);
  return renderToStaticMarkup(
    <MissionDetailView
      missionId="mission-1"
      title="Example mission"
      chip={{ label: 'NEEDS YOU', cls: 'border-accent text-accent-text' }}
      segments={segments}
      caption="6/15"
      back={{ label: 'Home', href: '/app/home' }}
      description={description}
      situation={<MissionSituationBlock missionId="mission-1" situation={situation as any} because={[]} />}
      delivery={
        <MissionDelivery
          steps={buildDeliverySteps({
            missionStatus: 'active', totalTasks: 15, completedTasks: 6, awaitingMerge: 0, integrationPr: null,
            criteria: { total: 0, passed: null, overall: null }, mergedAt: [], release: null, budget: null,
          })}
        />
      }
      feed={{ tasks, now: FIXTURE_NOW }}
      footer={<div data-testid="footer-marker" />}
    />,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('MissionDetailView — the answer before the evidence (AC-1)', () => {
  for (const size of [3, 15, 45] as const) {
    it(`orders masthead → situation → delivery → first task row (${size} tasks)`, () => {
      const html = renderMission(fixtureMission(size));
      const masthead = html.indexOf('data-testid="mission-masthead"');
      const sit = html.indexOf('data-testid="mission-situation"');
      const delivery = html.indexOf('data-testid="mission-delivery"');
      const firstRow = html.indexOf('data-testid="mission-task-row"');
      expect(masthead).toBeGreaterThan(-1);
      expect(masthead).toBeLessThan(sit);
      expect(sit).toBeLessThan(delivery);
      expect(delivery).toBeLessThan(firstRow);
    });
  }
});

describe('MissionDetailView — the description has one place (F5)', () => {
  it('renders the description once, between the masthead and the situation', () => {
    const html = renderMission(fixtureMission(3), <div data-testid="mission-description" />);
    expect(count(html, 'data-testid="mission-description"')).toBe(1);
    const masthead = html.indexOf('data-testid="mission-masthead"');
    const description = html.indexOf('data-testid="mission-description"');
    expect(masthead).toBeLessThan(description);
    expect(description).toBeLessThan(html.indexOf('data-testid="mission-situation"'));
  });
});

describe('MissionDetailView — one list (AC-2) and slot markers (AC-3)', () => {
  for (const size of [3, 15, 45] as const) {
    it(`renders every work task as exactly one row (${size} tasks)`, () => {
      const tasks = fixtureMission(size);
      const html = renderMission(tasks);
      for (const id of workTaskIds(tasks)) {
        expect(count(html, `data-testid="mission-task-row" data-task-id="${id}"`)).toBe(1);
      }
      expect(count(html, 'data-testid="mission-task-row"')).toBe(workTaskIds(tasks).length);
    });
  }

  it('gives each pinned task one slot marker and no second row', () => {
    const html = renderMission(fixtureMission(45));
    for (const id of ['p1-0', 'p1-1', 'p1-2', 'p1-3', 'p1-4']) {
      expect(count(html, `data-testid="mission-task-slot" data-task-id="${id}"`)).toBe(1);
      expect(count(html, `data-testid="mission-task-row" data-task-id="${id}"`)).toBe(1);
    }
  });
});

describe('MissionDetailView — the pulse in the header (AC-4)', () => {
  it('draws one segment per work task at 15, in groupTasksByPhase order', () => {
    const tasks = fixtureMission(15);
    const html = renderMission(tasks);
    const ids = [...html.matchAll(/data-testid="mission-pulse-segment" data-task-id="([^"]+)"/g)].map(m => m[1]);
    const expected = groupTasksByPhase(foldMissionDeliverables(tasks).rows.map(r => r.task)).flatMap(g => g.tasks.map(t => t.id));
    expect(ids).toEqual(expected);
  });

  it('folds to one segment per phase above the threshold', () => {
    const tasks = fixtureMission(45);
    expect(workTaskIds(tasks).length).toBeGreaterThan(PULSE_FOLD_THRESHOLD);
    const html = renderMission(tasks);
    expect(count(html, 'data-testid="mission-pulse-segment"')).toBe(3);
  });
});

describe('MissionDetailView — sticky masthead (AC-5)', () => {
  it('pins the masthead with sticky top-0', () => {
    const html = renderMission(fixtureMission(15));
    expect(html).toMatch(/data-testid="mission-masthead"[^>]*class="[^"]*\bsticky top-0\b/);
  });

  it('gives every row a scroll margin equal to the folded masthead height', () => {
    expect(MISSION_ROW_SCROLL_MARGIN_CLASS).toBe(`scroll-mt-[${MISSION_MASTHEAD_FOLDED_PX}px]`);
    const html = renderMission(fixtureMission(15));
    expect(count(html, MISSION_ROW_SCROLL_MARGIN_CLASS)).toBe(15);
  });
});

describe('MissionDetailView — md+ navigator', () => {
  // At md+ the time-axis strip replaces the header pulse ("Desktop
  // adaptation"). The rows the pulse focuses live only in the mobile list, so a
  // header pulse left visible at md+ would outline a display:none row on its
  // first click and do nothing visible.
  it('hides the header pulse at md and up, keeping it on mobile', () => {
    const html = renderMission(fixtureMission(15));
    expect(html).toMatch(/data-testid="mission-pulse" data-variant="header"[^>]*class="[^"]*\bmd:hidden\b/);
  });

  it('keeps the counts caption visible at every width', () => {
    const html = renderMission(fixtureMission(15));
    const caption = html.match(/<span class="([^"]*)">6\/15<\/span>/);
    expect(caption).not.toBeNull();
    expect(caption![1]).not.toContain('hidden');
  });
});

describe('MissionDetailView — copy that points somewhere (AC-16, page half)', () => {
  it('renders no "above ↑" pointer and no dead goal-criteria anchor', () => {
    const html = renderMission(fixtureMission(15));
    expect(html).not.toContain('See Goal Criteria above');
    expect(html).not.toContain('#mission-goal-criteria');
  });
});

describe('mastheadBack', () => {
  it('names Home when the reader came from Home', () => {
    expect(mastheadBack('home', [{ label: 'Missions', href: '/app/missions' }])).toEqual({ label: 'Home', href: '/app/home' });
  });

  it('otherwise names the nearest breadcrumb — the initiative when there is one', () => {
    expect(mastheadBack(undefined, [
      { label: 'Initiatives', href: '/app/initiatives' },
      { label: 'Example initiative', href: '/app/initiatives/i-1' },
    ])).toEqual({ label: 'Example initiative', href: '/app/initiatives/i-1' });
    expect(mastheadBack('missions', [{ label: 'Missions', href: '/app/missions' }])).toEqual({ label: 'Missions', href: '/app/missions' });
  });
});

describe('parseMissionOrigin', () => {
  it('keeps the three known origins and drops anything else', () => {
    expect(parseMissionOrigin('home')).toBe('home');
    expect(parseMissionOrigin('initiative')).toBe('initiative');
    expect(parseMissionOrigin('mission')).toBeNull();
    expect(parseMissionOrigin(undefined)).toBeNull();
  });
});
