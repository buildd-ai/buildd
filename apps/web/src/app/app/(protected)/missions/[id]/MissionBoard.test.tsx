/**
 * MissionBoard: the default mission layout. Rendered to static markup from
 * fixture models (no database) at three moments.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/app/missions/mission-1',
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: MissionBoard } = await import('./MissionBoard');
const { boardFixture } = await import('@/lib/mission-board.fixtures');

const render = (moment: Parameters<typeof boardFixture>[0], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<MissionBoard model={boardFixture(moment)} missionId="mission-1" {...extra} />);
const count = (html: string, needle: string) => html.split(needle).length - 1;
const tileStatuses = (html: string) =>
  [...html.matchAll(/data-testid="board-tile" data-status="([^"]+)"/g)].map(m => m[1]);

describe('MissionBoard — running', () => {
  const html = render('running');

  it('draws the band: landed, goal, fleet, needs you', () => {
    for (const id of ['mission-band', 'landed-band', 'goal-band', 'fleet-band', 'needs-you-cell']) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('nothing waiting');
    // Live partial count on the PR criterion.
    expect(html).toContain('1/4');
  });

  it('one column per phase, every deliverable exactly once, landed work as a row with its PR', () => {
    expect(count(html, 'data-testid="board-column"')).toBe(2);
    expect(tileStatuses(html).sort()).toEqual(['blocked', 'merged', 'running', 'running']);
    expect(html).toContain('#101');
  });

  it('a running tile has an elapsed strip with one notch per milestone', () => {
    expect(html).toContain('data-testid="board-tile-strip"');
    expect(count(html, 'data-testid="board-tile-notch"')).toBe(2);
  });

  it('a queued tile says what it waits on', () => {
    expect(html).toMatch(/after.*api/);
  });

  it('tiles open the task sheet: a real href plus data-task-id', () => {
    expect(html).toMatch(/href="\/app\/missions\/mission-1\?task=api" data-task-id="api"/);
  });

  it('shows the just-now ticker and no completion record', () => {
    expect(html).toContain('data-testid="mission-ticker"');
    expect(html).not.toContain('data-testid="mission-completion-record"');
  });

  it('colours the role glyph from the role data', () => {
    expect(html).toContain('color:var(--test-role-colour)');
  });
});

describe('MissionBoard — planning (no tasks yet)', () => {
  const html = render('planning');

  it('shows the planning placeholder with the organizer\'s live state, not an empty "Tasks 0/0" column', () => {
    expect(count(html, 'data-testid="board-column"')).toBe(0);
    expect(html).not.toContain('>0/0<');
    expect(html).not.toContain('data-testid="mission-board-columns"');
    expect(html).toContain('data-testid="board-planning"');
    expect(html).toContain('Organizer is planning');
    expect(html).toContain('Mapped the example tables');
    expect(html).toContain('alpha');
  });
});

describe('MissionBoard — a question open', () => {
  const html = render('question');

  it('raises the needs-you band with the prompt and one button per option, plus Reply…', () => {
    expect(html).toContain('data-testid="needs-you-band"');
    expect(html).toContain('Round each line or the total?');
    const options = html.slice(html.indexOf('data-testid="board-answer-options"'));
    expect(options).toContain('>Each line<');
    expect(options).toContain('>Total only<');
    expect(options).toContain('Reply…');
    expect(tileStatuses(html)).toContain('waiting');
  });
});

describe('MissionBoard — complete', () => {
  const html = render('complete', { completionText: 'Example outcome.' });

  it('shows the completion record and the concurrency chart, not the ticker', () => {
    expect(html).toContain('data-testid="mission-completion-record"');
    expect(html).toContain('Example outcome.');
    expect(html).toContain('data-testid="mission-concurrency"');
    expect(html).not.toContain('data-testid="mission-ticker"');
  });

  it('collapses every task to a landed row with its lines', () => {
    expect(tileStatuses(html)).toEqual(['merged', 'merged', 'merged', 'merged']);
    expect(html).toContain('+40');
    expect(html).toContain('all answered');
  });
});

describe('MissionBoard — demo v5 polish', () => {
  /** One tile's own markup, from its anchor to the next tile. */
  const tileOf = (html: string, id: string) => html.split(`data-task-id="${id}"`)[1]?.split(' data-task-id="')[0] ?? '';
  const runningWith = (patch: Record<string, unknown>) => {
    const model = boardFixture('running');
    const t = Object.values(model.tasks).find(x => x.status === 'running')!;
    Object.assign(t, patch);
    return { id: t.id, html: renderToStaticMarkup(<MissionBoard model={model} missionId="mission-1" />) };
  };

  it('a running tile with nothing to say has no second line (no empty gap under the title)', () => {
    const { id, html } = runningWith({ startedAt: null, milestones: [], currentAction: null, pr: null });
    expect(tileOf(html, id)).not.toBe('');
    expect(tileOf(html, id)).not.toContain('data-testid="board-tile-body"');
    expect(tileOf(html, id)).not.toContain('min-h-[18px]');
  });

  it('a running tile shows its current action and its elapsed time', () => {
    const { id, html } = runningWith({ currentAction: 'Editing invoices.ts' });
    const tile = tileOf(html, id);
    expect(tile).toContain('data-testid="board-tile-body"');
    expect(tile).toContain('data-testid="board-tile-action"');
    expect(tile).toContain('Editing invoices.ts');
  });

  it('the completion record puts its four numbers in one compact 2x2 block, not four prose-tall columns', () => {
    const html = render('complete', { completionText: 'Example outcome.' });
    const stats = html.split('data-testid="record-stats"')[1] ?? '';
    expect(stats).not.toBe('');
    for (const id of ['record-prs', 'record-lines', 'record-ci-fixes', 'record-decisions']) expect(stats).toContain(`data-testid="${id}"`);
    const section = html.match(/data-testid="mission-completion-record" class="([^"]*)"/)?.[1] ?? '';
    expect(section).not.toContain('repeat(4,');
// The docked chat pane and the phone sheet are far narrower than the page:
// criteria labels, phase headers, tile titles and the landed strip's captions
// all truncated there. `compact` is the narrow layout.
describe('MissionBoard — compact (docked pane / phone sheet)', () => {
  const model = boardFixture('running');
  const wide = render('running');
  const html = renderToStaticMarkup(<MissionBoard model={model} missionId="mission-1" compact />);

  it('marks the board compact and keeps the band two-up at every width', () => {
    expect(html).toContain('data-compact="true"');
    expect(wide).not.toContain('data-compact');
    const band = html.match(/<section data-testid="mission-band"[^>]*class="([^"]+)"/)![1];
    expect(band).not.toContain('md:grid-cols-[');
  });

  it('draws goal criteria as pips, each named in its title, with no truncated label rows', () => {
    expect(count(html, 'data-testid="goal-criterion-pip"')).toBe(model.criteria.length);
    expect(html).not.toContain('data-testid="goal-criterion"');
    for (const c of model.criteria) expect(html).toContain(`title="${c.label} · ${c.value}"`);
  });

  it('lets phase headers wrap instead of truncating', () => {
    const labels = [...html.matchAll(/data-testid="board-phase-label"[^>]*class="([^"]+)"/g)].map(m => m[1]);
    expect(labels.length).toBe(model.phases.length);
    for (const cls of labels) expect(cls.split(/\s+/)).not.toContain('truncate');
  });

  it('tile titles use the short label, wrapped to two lines with the full title on hover', () => {
    const titles = [...html.matchAll(/data-testid="board-tile-label"[^>]*class="([^"]+)"/g)].map(m => m[1]);
    expect(titles.length).toBeGreaterThan(0);
    for (const cls of titles) {
      expect(cls).toContain('line-clamp-2');
      expect(cls.split(/\s+/)).not.toContain('truncate');
    }
    const t = Object.values(model.tasks).find(x => x.status === 'running')!;
    expect(html).toContain(`title="${t.title}"`);
  });

  it('the landed strip captions drop the ordinal and never truncate', () => {
    const caps = [...html.matchAll(/data-testid="landed-phase-caption"[^>]*class="([^"]+)"[^>]*>([^<]+)</g)];
    expect(caps.length).toBe(model.phases.length);
    for (const [, cls, text] of caps) {
      expect(cls.split(/\s+/)).not.toContain('truncate');
      expect(text).toMatch(/^\d+\/\d+$/);
    }
  });
});
