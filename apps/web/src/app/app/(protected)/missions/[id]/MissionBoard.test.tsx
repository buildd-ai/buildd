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
