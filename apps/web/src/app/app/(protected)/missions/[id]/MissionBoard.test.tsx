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
const { buildVisualReviewFixtureModel } = await import('@/lib/visual-review-model.fixtures');
const { CanvasContext } = await import('@/components/chat/canvas-context');

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

  // Regression (surface audit, 390px/320px): a runner with ten slots ran its
  // boxes past the Fleet cell's divider onto "nothing waiting", and a phase's
  // progress squares pushed its count past the viewport. The slot row wraps
  // inside its cell; the squares give way before the label and count do.
  it('keeps a wide slot row inside the Fleet cell', () => {
    const rows = [...html.matchAll(/data-testid="fleet-runner"[^>]*class="([^"]+)"/g)].map(m => m[1].split(/\s+/));
    expect(rows.length).toBeGreaterThan(0);
    for (const cls of rows) {
      expect(cls).toContain('flex-wrap');
      expect(cls).toContain('min-w-0');
    }
  });

  it('lets the phase progress squares shrink so the count stays in view', () => {
    const bars = [...html.matchAll(/data-testid="board-phase-progress"[^>]*class="([^"]+)"/g)].map(m => m[1].split(/\s+/));
    expect(bars.length).toBeGreaterThan(0);
    for (const cls of bars) {
      expect(cls).toContain('min-w-0');
      expect(cls).toContain('overflow-hidden');
      expect(cls).not.toContain('shrink-0');
    }
  });

  // Regression (UX review, board at 390px): the band's 2x2 phone grid put the
  // goal beside Landed at half width, so criteria read "open ta…", "roundi…".
  // On a phone Landed and Goal each take the full row; Fleet and Needs you pair.
  it('gives Landed and Goal the full width on a phone', () => {
    for (const id of ['landed-band', 'goal-band']) {
      const cls = html.match(new RegExp(`data-testid="${id}"[^>]*class="([^"]*)"`))?.[1] ?? '';
      expect(cls).toMatch(/(^|\s)col-span-2(\s|$)/);
      expect(cls).toMatch(/(^|\s)md:col-span-1(\s|$)/);
    }
  });

  it('one column per phase, every deliverable exactly once, landed work as a row with its PR', () => {
    expect(count(html, 'data-testid="board-column"')).toBe(2);
    expect(tileStatuses(html).sort()).toEqual(['blocked', 'merged', 'running', 'running']);
    expect(html).toContain('#101');
  });

  // Regression (surface audit, 1280px): the 380px hover detail stayed laid out
  // while hidden (`invisible`), so it widened the page's scroll area beside
  // every tile. A single-phase board popped it right of a full-width tile,
  // 394px past the content edge, and the page captured 1642px wide.
  const popovers = (h: string) =>
    [...h.matchAll(/data-testid="board-tile-detail"[^>]*class="([^"]+)"/g)].map(m => m[1].split(/\s+/));

  it('takes the tile detail out of layout until it is shown', () => {
    const cls = popovers(html);
    expect(cls.length).toBeGreaterThan(0);
    for (const c of cls) {
      expect(c).toContain('hidden');
      expect(c).not.toContain('md:flex');
      expect(c).not.toContain('invisible');
      expect(c).toContain('md:group-hover:flex');
      expect(c).toContain('md:group-focus-within:flex');
    }
  });

  it('a single-phase board drops the tile detail below the tile, never beside it', () => {
    const m = boardFixture('running');
    const single = renderToStaticMarkup(<MissionBoard model={{ ...m, phases: [m.phases[0]] }} missionId="mission-1" />);
    const cls = popovers(single);
    expect(cls.length).toBeGreaterThan(0);
    for (const c of cls) {
      expect(c.some(k => k.startsWith('left-[calc') || k.startsWith('right-[calc'))).toBe(false);
      expect(c).toContain('right-0');
      expect(c).toContain('top-[calc(100%+6px)]');
    }
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

  it('Landed reads as an empty state until there are tasks, not "0 of 0"', () => {
    const landed = html.split('data-testid="landed-band"')[1]?.split('data-testid="goal-band"')[0] ?? '';
    expect(landed).not.toContain('of 0');
    expect(landed).toContain('data-testid="landed-empty"');
    expect(landed).not.toMatch(/>\s*[-\u2013\u2014]\s*</);
  });
});

describe('MissionBoard — band alignment', () => {
  const html = render('running');

  // The Goal label sat inside an inline <a>, whose line box (body font) pushed
  // it below Landed / Fleet / Needs you. The link must be a flex box like the cells.
  it('the Goal label link is a flex box, so its label shares the other cells\' baseline', () => {
    const goal = html.split('data-testid="goal-band"')[1] ?? '';
    const cls = goal.match(/<a href="#[^"]*" class="([^"]*)"/)?.[1] ?? '';
    expect(cls.split(/\s+/)).toContain('flex');
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
    for (const id of ['record-prs', 'record-lines', 'record-decisions']) expect(stats).toContain(`data-testid="${id}"`);
    const section = html.match(/data-testid="mission-completion-record" class="([^"]*)"/)?.[1] ?? '';
    expect(section).not.toContain('repeat(4,');
  });
});

// The docked chat pane and the phone sheet are far narrower than the page:
// criteria labels, phase headers, tile titles and the landed strip's captions
// all truncated there. `compact` is the narrow layout.
describe('MissionBoard — compact (docked pane / phone sheet)', () => {
  const model = boardFixture('running');
  const wide = render('running');
  const html = renderToStaticMarkup(<MissionBoard model={model} missionId="mission-1" compact />);

  it('marks the board compact; the wide board is unchanged', () => {
    expect(html).toContain('data-compact="true"');
    expect(wide).not.toContain('data-compact');
    expect(wide).toContain('data-testid="goal-criterion"');
    expect(wide).not.toContain('data-testid="goal-criterion-pip"');
  });

  it('draws goal criteria as pips, each named in its title, with no truncated label rows', () => {
    expect(count(html, 'data-testid="goal-criterion-pip"')).toBe(model.criteria.length);
    expect(html).not.toContain('data-testid="goal-criterion"');
    for (const c of model.criteria) expect(html).toContain(`title="${c.label} · ${c.value}"`);
  });

  // A wrapped phase header pushed its underline below its neighbours'. One line,
  // the full name on hover.
  it('phase headers stay on one line with the full name in a title', () => {
    const labels = [...html.matchAll(/data-testid="board-phase-label"[^>]*title="([^"]+)"[^>]*class="([^"]+)"/g)];
    expect(labels.length).toBe(model.phases.length);
    for (const [, title, cls] of labels) {
      expect(cls.split(/\s+/)).toContain('truncate');
      expect(title.length).toBeGreaterThan(0);
    }
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

// Visual review on the Board: before, the auditor showed only as a landed row
// marked "report", and the shots rendered in the Feed layout alone.
describe('MissionBoard — visual review (docs/design/visual-qa-human-review.md)', () => {
  type Phase = Parameters<typeof buildVisualReviewFixtureModel>[0];
  type Opts = Parameters<typeof buildVisualReviewFixtureModel>[1];
  /** A fixture model whose latest audit is the board task `auditId`. */
  const visualAs = (auditId: string, phase: Phase, opts?: Opts) => {
    const m = buildVisualReviewFixtureModel(phase, opts);
    return {
      ...m,
      missionId: 'mission-1',
      audit: m.audit ? { ...m.audit, id: auditId } : null,
      needsYou: m.needsYou?.taskId ? { ...m.needsYou, taskId: auditId } : m.needsYou,
      bootFailure: m.bootFailure ? { ...m.bootFailure, taskId: auditId } : null,
    };
  };
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('the auditor\'s tile carries the Tray, directly after its row inside the columns', () => {
    const visual = visualAs('guide', 'reviewed');
    const html = render('complete', { completionText: 'x', visual });
    const cols = html.split('data-testid="mission-board-columns"')[1].split('data-testid="mission-concurrency"')[0];
    const afterGuide = cols.split('data-task-id="guide"')[1] ?? '';
    expect(afterGuide).toContain('data-testid="board-visual-tray"');
    expect(count(html, 'data-testid="visual-review-thumb"')).toBe(visual.cells.length);
    expect(html).not.toContain('data-testid="board-visual-section"');
  });

  it('falls back to a section under the columns when the audit is not on the board', () => {
    const html = render('running', { visual: visualAs('not-on-board', 'reviewed') });
    expect(html).toContain('data-testid="board-visual-section"');
    expect(html).not.toContain('data-testid="board-visual-tray"');
  });

  it('draws nothing visual without a model', () => {
    const html = render('running');
    for (const id of ['visual-band', 'board-visual-tray', 'board-visual-section', 'visual-review-ask']) {
      expect(html).not.toContain(`data-testid="${id}"`);
    }
  });

  it('a pending audit with no shots is on the board: the Band row says why, the Tray offers the way out', () => {
    const html = render('running', { visual: visualAs('guide', 'no_browser_runner') });
    expect(html).toMatch(/data-testid="visual-band" data-phase="no_browser_runner"/);
    expect(text(html)).toContain('No browser runner');
    expect(html).toContain('data-testid="visual-review-action-turn-off"');
    expect(html).toContain('data-testid="visual-review-action-skip"');
  });

  it('stalled and boot-failed audits show too', () => {
    expect(render('running', { visual: visualAs('guide', 'stalled') })).toContain('data-testid="visual-review-action-retry"');
    expect(render('running', { visual: visualAs('guide', 'boot_failed') })).toMatch(/data-testid="visual-band" data-phase="boot_failed"/);
  });

  it('Needs you counts the screens awaiting you, and the Ask sits with the asks', () => {
    const visual = visualAs('guide', 'needs_you', { needsYou: 'unsure', scenario: 'deck' });
    const html = render('running', { visual });
    const cell = html.split('data-testid="needs-you-cell"')[1]?.split('</div>')[0] ?? '';
    expect(text(cell)).toContain(String(visual.summary.awaitingHuman));
    expect(text(html)).toContain(`${visual.summary.awaitingHuman} ${visual.summary.awaitingHuman === 1 ? 'screen' : 'screens'} to review`);
    expect(html).toContain('data-testid="visual-review-ask"');
    // Before the columns, beside the other asks.
    expect(html.indexOf('data-testid="visual-review-ask"')).toBeLessThan(html.indexOf('data-testid="mission-board-columns"'));
  });

  it('a question the auditor\'s worker asks is the board\'s own ask: not a second card', () => {
    // boardFixture('question') parks `pay`: let the audit be that task.
    const html = render('question', { visual: visualAs('pay', 'needs_you', { needsYou: 'question' }) });
    expect(html).toContain('data-testid="needs-you-band"');
    expect(html).not.toContain('data-testid="visual-review-ask"');
  });

  it('the completion record counts the screens and your calls on them', () => {
    const visual = visualAs('guide', 'reviewed');
    const html = render('complete', { completionText: 'x', visual });
    const stats = html.split('data-testid="record-stats"')[1] ?? '';
    expect(stats).not.toContain('data-testid="record-ci-fixes"');
    const screens = stats.split('data-testid="record-screens"')[1]?.split('data-testid="record-')[0] ?? '';
    expect(text(screens)).toContain(`Screens reviewed ${visual.summary.shots}`);
    const calls = stats.split('data-testid="record-screen-calls"')[1]?.split('data-testid="record-')[0] ?? '';
    expect(text(calls)).toContain(`${visual.summary.reviewed}`);
    expect(text(calls)).toMatch(/agreed|waived|disputed/);
  });

  it('the completion record keeps CI auto-fix when something was fixed', () => {
    const model = boardFixture('complete');
    model.record.ciFixes = 2;
    const html = renderToStaticMarkup(<MissionBoard model={model} missionId="mission-1" completionText="x" />);
    expect(html).toContain('data-testid="record-ci-fixes"');
    expect(html).not.toContain('data-testid="record-screens"');
  });

  // Review regressions (S4 PR review).
  it('a phase-off model (no audit, the chat pane passes it as is) draws nothing visual', () => {
    const off = { ...buildVisualReviewFixtureModel('off'), missionId: 'mission-1' };
    for (const moment of ['running', 'complete'] as const) {
      const html = render(moment, { completionText: 'x', visual: off });
      for (const id of ['board-visual-section', 'board-visual-tray', 'visual-band', 'visual-review-tray']) {
        expect(html).not.toContain(`data-testid="${id}"`);
      }
      expect(text(html)).not.toContain('No visual audit on this mission');
    }
  });

  it('the completion record counts screens after your decisions, like the Band does', () => {
    // Fixture: the agent said 6 ok and 1 unsure; your decisions make all 7 ok.
    const visual = visualAs('guide', 'reviewed');
    const s = visual.summary;
    expect(s.ok).toBeLessThan(s.shots);
    expect(s.effectiveOk).toBe(s.shots);
    const html = render('complete', { completionText: 'x', visual });
    const stats = html.split('data-testid="record-stats"')[1] ?? '';
    const screens = text(stats.split('data-testid="record-screens"')[1]?.split('data-testid="record-')[0] ?? '');
    expect(screens).toContain('all ok');
    expect(screens).not.toContain('unsure');
    expect(screens).not.toContain(`${s.ok} of ${s.shots}`);
    // "Your decisions" read as the screen decisions: the mission's answers are "Your answers".
    expect(text(stats)).toContain('Your answers');
    expect(text(stats)).not.toContain('Your decisions');
  });

  it('with issues left after your calls, the record says how many', () => {
    const base = visualAs('guide', 'reviewed');
    const visual = { ...base, summary: { ...base.summary, effectiveOk: base.summary.shots - 2, effectiveIssues: 2 } };
    const html = render('complete', { completionText: 'x', visual });
    const screens = text(html.split('data-testid="record-screens"')[1]?.split('data-testid="record-')[0] ?? '');
    expect(screens).toContain(`${visual.summary.shots - 2} of ${visual.summary.shots} ok`);
    expect(screens).toContain('2 issues');
  });

  it('no browser runner: the audit tile and Needs you say the audit is stuck', () => {
    const model = boardFixture('running');
    model.tasks.guide = { ...model.tasks.guide, status: 'ready' };
    const html = renderToStaticMarkup(<MissionBoard model={model} missionId="mission-1" visual={visualAs('guide', 'no_browser_runner')} />);
    const tile = html.split('data-task-id="guide"')[1]?.split('data-testid="board-visual-tray"')[0] ?? '';
    expect(text(tile)).not.toContain('next free slot');
    expect(text(tile)).toContain('waiting for a browser runner');
    const cell = text(html.split('data-testid="needs-you-cell"')[1]?.split('</div>')[0] ?? '');
    expect(cell).not.toContain('nothing waiting');
    expect(cell).toContain('visual audit is stuck');
  });

  it('stalled: the live audit tile and Needs you say the audit is stuck', () => {
    const model = boardFixture('running');
    model.tasks.guide = { ...model.tasks.guide, status: 'running', startedAt: null, currentAction: null };
    const html = renderToStaticMarkup(<MissionBoard model={model} missionId="mission-1" visual={visualAs('guide', 'stalled')} />);
    const tile = html.split('data-task-id="guide"')[1]?.split('data-testid="board-visual-tray"')[0] ?? '';
    expect(text(tile)).toContain('visual audit stalled');
    const cell = text(html.split('data-testid="needs-you-cell"')[1]?.split('</div>')[0] ?? '');
    expect(cell).toContain('visual audit is stuck');
  });

  it('while the Ask shows, the Tray has no second Review button and the Band row no repeat sentence', () => {
    const visual = visualAs('guide', 'needs_you', { needsYou: 'unsure', scenario: 'deck' });
    const html = render('running', { visual });
    expect(html).toContain('data-testid="visual-review-ask"');
    expect(html).not.toContain('data-testid="visual-review-review-button"');
    const band = html.split('data-testid="visual-band"')[1]?.split('</section>')[0] ?? '';
    expect(band).toContain('data-testid="visual-review-line-label"');
    expect(band).not.toContain('data-testid="visual-review-line-detail"');
  });

  it('with no Ask (reviewed), the Tray keeps its Review button', () => {
    const html = render('running', { visual: visualAs('guide', 'reviewed') });
    expect(html).toContain('data-testid="visual-review-review-button"');
  });
});

describe('MissionBoard — complete, open for weeks', () => {
  const html = render('long-open', { completionText: 'Webhooks now retry for a day, then park.' });
  const record = html.split('data-testid="mission-completion-record"')[1]?.split('</section>')[0] ?? '';

  it('the completion record is one compact card: the summary, then the numbers in a row', () => {
    expect(record).toContain('Webhooks now retry for a day, then park.');
    expect(record).toContain('data-testid="record-stats"');
    // No big label-only block beside the stats.
    expect(html).not.toMatch(/data-testid="mission-completion-record" class="[^"]*grid-cols-\[1\.4fr_1fr\]/);
  });

  it('the record names work time and open time in readable units', () => {
    const time = record.split('data-testid="record-time"')[1] ?? '';
    expect(time).toContain('40m');
    expect(time).toContain('open 35d');
  });

  it('says once that nothing evaluated the criteria, with Check now, instead of per-row noise', () => {
    const goal = html.split('data-testid="goal-band"')[1]?.split('data-testid="fleet-band"')[0] ?? '';
    expect(count(goal, 'Criteria not evaluated')).toBe(1);
    expect(goal).toContain('data-testid="criteria-check-now"');
    expect(goal).not.toContain('not checked');
  });

  it('the agents-over-time axis reads in days, with a handful of ticks', () => {
    const conc = html.split('data-testid="mission-concurrency"')[1] ?? '';
    const ticks = [...conc.matchAll(/data-testid="concurrency-tick"/g)].length;
    expect(ticks).toBeGreaterThan(1);
    expect(ticks).toBeLessThanOrEqual(12);
    expect(conc).toMatch(/>\d+d</);
  });
});

describe('MissionBoard — Steer', () => {
  it('a running tile offers Steer when the chat canvas is available', () => {
    const html = renderToStaticMarkup(
      <CanvasContext.Provider value={{ open: () => {}, openSteer: () => {}, close: () => {}, isOpen: false }}>
        <MissionBoard model={boardFixture('running')} missionId="mission-1" />
      </CanvasContext.Provider>,
    );
    // 'running' has two live (running) tiles per tileStatuses above.
    expect(count(html, 'data-testid="steer-trigger"')).toBe(2);
  });

  it('offers nothing to steer without the chat canvas (no provider, or chat unavailable)', () => {
    expect(render('running')).not.toContain('steer-trigger');
    const html = renderToStaticMarkup(
      <CanvasContext.Provider value={null}>
        <MissionBoard model={boardFixture('running')} missionId="mission-1" />
      </CanvasContext.Provider>,
    );
    expect(html).not.toContain('steer-trigger');
  });
});
