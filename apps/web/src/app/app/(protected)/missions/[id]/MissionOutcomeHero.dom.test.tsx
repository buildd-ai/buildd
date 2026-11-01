/**
 * The completed mission's outcome hero, mounted (happy-dom), with the page's one
 * Records sheet beside it (Navigation R-23 to R-27, AC-19, AC-20, AC-22).
 * Fixtures are illustrative: a research mission shaped like the one that
 * triggered this (ten reports, one from its closeout task, no PR), a research
 * mission with no primary outcome, and a mixed mission.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionOutcomeHero } = await import('./MissionOutcomeHero');
const { default: MissionRecordsSheet } = await import('./MissionRecordsSheet');
const { buildOutcomeHero } = await import('@/lib/mission-outcome');

const M = 'm1';
const CLOSEOUT = 'task-closeout';
const FINAL_BODY = '# Mission final\n\nAggregates the eight read-throughs and says what to adopt. No code or PR was produced.\n\n## Verdicts\n\n- adopt: x';

const reports = [
  ...Array.from({ length: 9 }, (_, i) => ({ id: `r${i + 1}`, title: `Read-through ${i + 1}`, type: 'report', taskId: `task-${i + 1}`, metadata: {} })),
  { id: 'final', title: 'Mission final: what to adopt', type: 'report', taskId: CLOSEOUT, metadata: {} },
];
const viewerItems = reports.map(r => ({
  id: r.id, type: r.type, title: r.title, content: r.id === 'final' ? FINAL_BODY : `Body of ${r.id}`, shareToken: null,
  visibility: 'private' as const, metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', taskTitle: 'Example task',
}));

const research = () => buildOutcomeHero({
  missionId: M, artifacts: reports, storedPrimary: null, closeoutTaskIds: new Set([CLOSEOUT]),
  deliverablePrCount: 0, tasks: { merged: 0, done: 8 }, lede: null, primaryContent: FINAL_BODY,
  shipped: false, target: 'dev', release: 'waiting',
})!;

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('the research outcome (AC-19, AC-21)', () => {
  it('leads with Outcome ready, the closeout report, its opening paragraph and Open report', () => {
    act(() => root.render(<MissionOutcomeHero missionId={M} view={research()} />));
    const hero = q('mission-outcome-hero')!;
    expect(hero.id).toBe('what-shipped');
    expect(hero.getAttribute('aria-labelledby')).toBe('mission-outcome-words');
    expect(q('outcome-words')?.textContent).toBe('Outcome ready');
    expect(q('outcome-title')?.textContent).toBe('Mission final: what to adopt');
    expect(q('outcome-lede')?.textContent).toBe('Aggregates the eight read-throughs and says what to adopt. No code or PR was produced.');
    expect(q('outcome-open')?.textContent).toBe('Open report');
    expect(q('outcome-open')?.getAttribute('href')).toBe('/app/missions/m1?artifact=final');
    expect(q('outcome-supporting')?.textContent).toBe('Supporting reports · 9 ›');
    for (const word of ['Merge into dev', 'Release', 'Mission PR', 'PRs merged', 'tasks merged', 'Delivered', 'Deployed']) {
      expect(hero.textContent).not.toContain(word);
    }
  });

  it('keeps the R-27 focus order: title, primary action, supporting link', () => {
    act(() => root.render(<MissionOutcomeHero missionId={M} view={research()} />));
    const focusable = Array.from(q('mission-outcome-hero')!.querySelectorAll('a, button')).map(e => (e as HTMLElement).dataset.testid);
    expect(focusable).toEqual(['outcome-title', 'outcome-open', 'outcome-supporting']);
  });

  it('Open report opens that report in place, and Supporting reports lists the nine others', async () => {
    act(() => root.render(
      <>
        <MissionOutcomeHero missionId={M} view={research()} />
        <MissionRecordsSheet missionId={M} baseUrl="https://example.test" records={viewerItems} allArtifacts={viewerItems} loadContent={async () => ({})} />
      </>,
    ));
    act(() => { q('outcome-open')!.click(); });
    await flush();
    expect(document.querySelector('[data-testid="mission-records-sheet"]')).not.toBeNull();
    expect(window.location.search).toBe('?artifact=final');
    expect(document.body.textContent).toContain('Aggregates the eight read-throughs');

    act(() => { (document.querySelector('[data-testid="mission-records-row"]') as HTMLElement).click(); });
    act(() => { q('outcome-supporting')!.click(); });
    await flush();
    const rows = Array.from(document.querySelectorAll('[data-testid="mission-artifact-row"]')).map(r => r.textContent ?? '');
    expect(rows).toHaveLength(9);
    expect(rows.some(r => r.includes('Mission final'))).toBe(false);
  });
});

describe('no primary outcome (AC-20)', () => {
  it('lists every report, closeout first, and promotes none', () => {
    const three = [
      { id: 'a', title: 'Alpha', type: 'report', taskId: 't-a', metadata: {} },
      { id: 'b', title: 'Beta', type: 'report', taskId: 't-b', metadata: {} },
      { id: 'c', title: 'Newest', type: 'report', taskId: 't-c', metadata: {} },
    ];
    const view = buildOutcomeHero({
      missionId: M, artifacts: three, storedPrimary: null, closeoutTaskIds: new Set(['t-b', 't-c']),
      deliverablePrCount: 0, tasks: { merged: 0, done: 3 }, lede: null, shipped: false, target: 'dev', release: 'not_configured',
    })!;
    act(() => root.render(<MissionOutcomeHero missionId={M} view={view} />));
    expect(q('outcome-words')?.textContent).toBe('Outcome ready · 3 reports');
    expect(Array.from(container.querySelectorAll('[data-testid="outcome-report"]')).map(a => a.textContent)).toEqual(['Beta›', 'Newest›', 'Alpha›']);
    expect(q('outcome-choose')?.textContent).toBe('Choose the main report ›');
    expect(q('outcome-title')).toBeNull();
    expect(q('outcome-open')).toBeNull();
  });
});

describe('a mixed outcome (AC-22)', () => {
  const mixed = (release: 'waiting' | 'healthy') => buildOutcomeHero({
    missionId: M, artifacts: [{ id: 'finding', title: 'Pricing findings', type: 'report', taskId: 't-1', metadata: {} }],
    storedPrimary: { artifactId: 'finding', source: 'author' }, closeoutTaskIds: new Set(),
    deliverablePrCount: 3, tasks: { merged: 3, done: 0 }, lede: 'Prices now follow the findings.', shipped: true,
    target: 'dev', release, releaseLabel: 'v0.318',
  })!;

  it('shows the report and the delivery line, release queued then deployed', () => {
    act(() => root.render(<MissionOutcomeHero missionId={M} view={mixed('waiting')} />));
    expect(q('outcome-words')?.textContent).toBe('Outcome ready');
    expect(q('outcome-title')?.textContent).toBe('Pricing findings');
    expect(q('outcome-delivery')?.textContent).toBe('Delivered into dev · release queued');
    act(() => root.render(<MissionOutcomeHero missionId={M} view={mixed('healthy')} />));
    expect(q('outcome-delivery')?.textContent).toBe('Delivered into dev · deployed v0.318');
  });
});

describe('choosing the outcome on a Records row (I-28 rule 1)', () => {
  it('offers Make this the outcome on eligible rows and marks the current one', async () => {
    const chosen: Array<string | null> = [];
    act(() => root.render(
      <MissionRecordsSheet
        missionId={M} baseUrl="https://example.test" records={viewerItems} allArtifacts={viewerItems} loadContent={async () => ({})}
        defaultOpen outcome={{ primaryId: 'final', eligibleIds: reports.map(r => r.id) }}
        chooseOutcome={async (_m, id) => { chosen.push(id); return true; }}
      />,
    ));
    const buttons = Array.from(document.querySelectorAll('[data-testid="outcome-choice"]')) as HTMLElement[];
    expect(buttons).toHaveLength(10);
    const current = buttons.find(b => b.dataset.current === 'true')!;
    expect(current.textContent).toBe('Outcome · Clear');
    const other = buttons.find(b => b.dataset.current !== 'true')!;
    expect(other.textContent).toBe('Make this the outcome');
    await act(async () => { other.click(); });
    await act(async () => { current.click(); });
    expect(chosen[0]).toMatch(/^r\d$/);
    expect(chosen[1]).toBeNull();
  });
});
