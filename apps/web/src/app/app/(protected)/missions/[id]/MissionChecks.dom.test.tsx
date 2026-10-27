/**
 * The checks card mounted (happy-dom), spec f7f67f1a r8:
 *
 * - R-34 / AC-17: Skip sits beside a waivable check's status, opens one reason
 *   field in place and records the existing waiver (PATCH surfaceAuditWaiver);
 *   a closed mission, a recorded waiver or no mission page offers no Skip.
 * - R-35 / AC-18: the active stage is the running hue and thicker, never ink.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let refreshed = 0;
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => { refreshed++; } }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ChecksCard, CheckRail, OutcomeSpecLines, RequirementsView, StandardsLineView } = await import('./MissionChecks');
import type { MissionVerifyView, VerifyGroup } from '@/lib/mission-verify-view';
import type { StandardsLine } from '@/lib/specs/mission-standards-gate';
const { MissionSurfaceAuditWaiverProvider } = await import('./MissionSurfaceAuditWaiver');
import type { CheckRow } from '@/lib/mission-checks';

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string; body: unknown }[] = [];

beforeEach(() => {
  refreshed = 0;
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
});

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

const row = (over: Partial<CheckRow> = {}): CheckRow => ({
  key: 'visual', kind: 'visual', label: 'Visual review', chip: 'blocks finish', blocks: true, status: 'queued', state: 'queued',
  detail: null, target: 'dev', commit: null, actor: 'system', problem: null, findings: null, repairs: [], evidence: [], waivable: true, ...over,
});

function mount(rows: CheckRow[], ctx: { readonly?: boolean; waiver?: { reason: string; actorLabel: string | null; at: string } | null } | null = {}) {
  const card = <ChecksCard rows={rows} />;
  act(() => root.render(ctx
    ? <MissionSurfaceAuditWaiverProvider missionId="m1" waiver={ctx.waiver ?? null} missionBranch={false} readonly={ctx.readonly ?? false}>{card}</MissionSurfaceAuditWaiverProvider>
    : card));
}

// Spec 072de598 r15 I-7 / AC-26: Skip is two buttons, an optional note, no minimum length, one tap.
describe('Skip on a check (I-7, AC-26)', () => {
  it('opens two buttons with an optional note; tapping one skips immediately with no minimum length', async () => {
    mount([row()]);
    expect(q('[data-testid="mission-check-skip-form"]')).toBeNull();
    await act(async () => { q('[data-testid="mission-check-skip"]')!.click(); });
    expect(q('[data-testid="mission-check-skip-wrong"]')).not.toBeNull();
    expect(q('[data-testid="mission-check-skip-ship"]')).not.toBeNull();
    await act(async () => { q('[data-testid="mission-check-skip-ship"]')!.click(); });
    await flush();
    expect(calls).toEqual([{ url: '/api/missions/m1', method: 'PATCH', body: { surfaceAuditWaiver: { reason: 'ship_anyway' } } }]);
    expect(refreshed).toBe(1);
    expect(q('[data-testid="mission-check-skip-form"]')).toBeNull();
  });

  it('a typed note rides along with the button pressed', async () => {
    mount([row()]);
    await act(async () => { q('[data-testid="mission-check-skip"]')!.click(); });
    const note = q('[data-testid="mission-check-skip-note"]') as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(note, 'shots of the wrong page');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('[data-testid="mission-check-skip-wrong"]')!.click(); });
    await flush();
    expect(calls).toEqual([{ url: '/api/missions/m1', method: 'PATCH', body: { surfaceAuditWaiver: { reason: 'wrong_or_stuck', note: 'shots of the wrong page' } } }]);
  });

  it('cancel closes the form without a request', async () => {
    mount([row()]);
    await act(async () => { q('[data-testid="mission-check-skip"]')!.click(); });
    await act(async () => { q('[data-testid="mission-check-skip-cancel"]')!.click(); });
    expect(q('[data-testid="mission-check-skip-form"]')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a closed mission, a recorded waiver, no mission page or a row that cannot be waived offer no Skip', () => {
    for (const [rows, ctx] of [
      [[row()], { readonly: true }],
      [[row()], { waiver: { reason: 'Copy only, no screens', actorLabel: 'Owner', at: '2026-10-14T00:00:00Z' } }],
      [[row()], null],
      [[row({ waivable: false })], {}],
    ] as const) {
      mount([...rows], ctx);
      expect(q('[data-testid="mission-check-skip"]')).toBeNull();
    }
  });
});

describe('the spec line (Navigation R-3)', () => {
  it('reads Spec <name> linking to the spec, with no revision, status or count', () => {
    act(() => root.render(<OutcomeSpecLines lines={[{ specId: 's1', title: 'Cloud runner: deploy from Settings', revision: 'rev 8', status: 'not checked', href: '/app/specs/s1' }]} />));
    const line = q('[data-testid="mission-outcome-spec"]')!;
    expect(line.textContent).toBe('SpecCloud runner: deploy from Settings');
    expect(line.querySelector('a')!.getAttribute('href')).toBe('/app/specs/s1');
  });

  it('the name reads as a link (link hue, underlined), not as plain text beside `Spec`', () => {
    act(() => root.render(<OutcomeSpecLines lines={[{ specId: 's1', title: 'Cloud runner', revision: 'rev 8', status: 'not checked', href: '/app/specs/s1' }]} />));
    const cls = q('[data-testid="mission-outcome-spec"] a')!.className.split(' ');
    expect(cls).toContain('text-accent-text');
    expect(cls).toContain('underline');
    expect(cls).not.toContain('text-text-primary');
  });

  it('several selected specs read Specs <a>, <b>', () => {
    act(() => root.render(<OutcomeSpecLines lines={[
      { specId: 's1', title: 'Cloud runner: deploy from Settings', revision: 'rev 8', status: 'passed', href: '/app/specs/s1' },
      { specId: 's2', title: 'Settings: Runners', revision: 'rev 2', status: 'not checked', href: '/app/specs/s2' },
    ]} />));
    expect(q('[data-testid="mission-outcome-spec"]')!.textContent).toBe('SpecsCloud runner: deploy from Settings, Settings: Runners');
  });
});

describe('the stage line (Navigation R-3, R-15)', () => {
  const steps = () => Array.from(document.querySelectorAll('[data-step]'));
  const text = () => steps().map(s => s.textContent);
  const bold = () => steps().map(s => s.querySelector('[data-testid="mission-stage-label"]')!.className.includes('font-semibold'));

  it('is one line of text, no progress segments: `Build · 11 of 16   Verify   Deliver`, the current stage bold', () => {
    act(() => root.render(<CheckRail steps={[
      { key: 'build', label: 'Build', state: 'now', text: '11 of 16 done' },
      { key: 'verify', label: 'Verify', state: 'todo', text: 'after build' },
      { key: 'deliver', label: 'Deliver', state: 'todo', text: 'into dev' },
    ]} />));
    expect(text()).toEqual(['Build · 11 of 16', 'Verify', 'Deliver']);
    expect(bold()).toEqual([true, false, false]);
    expect(document.querySelector('[data-testid="mission-check-rail-bar"]')).toBeNull();
    expect(steps()[0].getAttribute('aria-current')).toBe('step');
  });

  it('a finished stage is its word and a tick; a stage not started is one word', () => {
    act(() => root.render(<CheckRail steps={[
      { key: 'build', label: 'Build', state: 'done', text: '10 of 10' },
      { key: 'verify', label: 'Verify', state: 'now', text: 'capturing 6 of 8' },
      { key: 'deliver', label: 'Deliver', state: 'todo', text: 'into dev' },
    ]} />));
    expect(text()).toEqual(['Build ✓', 'Verify', 'Deliver']);
    expect(bold()).toEqual([false, true, false]);
  });

  it('delivered: every stage ticked, Deliver bold', () => {
    act(() => root.render(<CheckRail steps={[
      { key: 'build', label: 'Build', state: 'done', text: '10 of 10' },
      { key: 'verify', label: 'Verify', state: 'done', text: '3 of 3 passed' },
      { key: 'deliver', label: 'Deliver', state: 'done', text: 'merged into dev' },
    ]} />));
    expect(text()).toEqual(['Build ✓', 'Verify ✓', 'Deliver ✓']);
    expect(bold()).toEqual([false, false, true]);
  });

  it('a held stage says why, in the error hue, so it never reads as plain progress', () => {
    act(() => root.render(<CheckRail steps={[
      { key: 'build', label: 'Build', state: 'done', text: '5 of 5' },
      { key: 'verify', label: 'Verify', state: 'held', text: 'unable to run' },
      { key: 'deliver', label: 'Deliver', state: 'todo', text: 'into dev' },
    ]} />));
    expect(text()).toEqual(['Build ✓', 'Verify · unable to run', 'Deliver']);
    expect(steps()[1].className).toContain('text-status-error');
  });
});

// Spec 072de598 I-20 to I-24, AC-28, AC-30 to AC-32.
describe('Delivery and Checks (I-22 to I-24)', () => {
  const { DeliveryChecks } = require('./MissionChecks') as typeof import('./MissionChecks');
  const checks = [
    { key: 'visual', name: 'Visual review', status: 'skipped', stateWord: 'Skipped', detail: '0 screens · 90df389', href: '/s', skippable: false, current: false, repairs: [] },
    { key: 'merge', name: 'Merge into dev', status: 'running', stateWord: 'In review', detail: '#5701', href: '/p', skippable: false, current: true, repairs: [] },
    { key: 'release', name: 'Release', status: 'queued', stateWord: 'Queued', detail: 'after #5701', href: '/r', skippable: false, current: false, repairs: [] },
  ] as const;
  const delivery = { line: '5 merged · 1 open · 7 no PR', prs: [{ key: 'a', title: 'A change', number: 5701, href: '/pr', status: 'queued', taskId: 'a' }] } as const;

  it('reads three rows in order, the current one marked, with no sentence or Open button', () => {
    act(() => root.render(<DeliveryChecks checks={[...checks]} delivery={{ ...delivery, prs: [...delivery.prs] }} timelineHref="/t" />));
    const rows = Array.from(document.querySelectorAll('[data-testid="mission-check"]'));
    expect(rows.map(r => r.textContent)).toEqual(['Visual review0 screens · 90df389Skipped', 'Merge into dev#5701In review', 'Releaseafter #5701Queued']);
    expect(rows.map(r => r.getAttribute('data-current'))).toEqual([null, 'true', null]);
    const all = document.body.textContent!;
    expect(all).not.toMatch(/Open the PR|Open release|reviewer|view timeline|unmerged|completed|\(no PR\)/);
    expect(q('[data-testid="mission-delivery-line"]')!.textContent).toBe('5 merged · 1 open · 7 no PR');
    expect(q('[data-testid="mission-delivery-timeline"]')!.textContent).toBe('Timeline ›');
  });

  it('lets a check name wrap so a narrow desktop step never clips it', () => {
    act(() => root.render(<DeliveryChecks checks={[...checks]} delivery={null} timelineHref="/t" />));
    const names = Array.from(document.querySelectorAll('[data-testid="mission-check"] [data-testid="check-row"] a span.font-medium'));
    expect(names.length).toBe(3);
    for (const n of names) expect(n.className).not.toContain('truncate');
  });

  it('renders nothing with no checks and no delivery', () => {
    act(() => root.render(<DeliveryChecks checks={[]} delivery={null} timelineHref="/t" />));
    expect(container.innerHTML).toBe('');
  });

  it('Skip is a control inside the visual review row', async () => {
    const skippable = [{ ...checks[0], status: 'queued', stateWord: 'Queued', skippable: true }, checks[1], checks[2]] as never;
    act(() => root.render(<MissionSurfaceAuditWaiverProvider missionId="m1" waiver={null} missionBranch={false} readonly={false}><DeliveryChecks checks={skippable} delivery={null} timelineHref="/t" /></MissionSurfaceAuditWaiverProvider>));
    expect(document.querySelectorAll('[data-testid="mission-check-skip"]')).toHaveLength(1);
    await act(async () => { q('[data-testid="mission-check-skip"]')!.click(); });
    expect(q('[data-testid="mission-check-skip-wrong"]')).not.toBeNull();
  });
});

describe('the spec row (items 6 to 8)', () => {
  const specRow = (over: Partial<CheckRow> = {}): CheckRow => row({
    key: 'criterion-0', kind: 'criterion', label: 'Spec revision 2', chip: 'goal', waivable: false, status: 'queued', state: 'not checked',
    detail: 'Zero of two pass. Nothing checked: 2 test files not found.', href: '/app/specs/s1?revision=2',
    criteria: [
      { id: 'R-1', text: 'A queued task waits for a free slot.', result: 'not checked', reason: 'test file not found' },
      { id: 'AC-3', text: 'The warning names the limit.', result: 'passed', reason: null },
    ], ...over,
  });

  it('opens the spec at its revision when the name is tapped', () => {
    mount([specRow()], null);
    const link = q('[data-testid="mission-check-link"]') as HTMLAnchorElement;
    expect(link.textContent).toBe('Spec revision 2');
    expect(link.getAttribute('href')).toBe('/app/specs/s1?revision=2');
  });

  it('lists each requirement in its own words with its result and reason; the id is secondary', () => {
    mount([specRow()], null);
    const items = [...document.querySelectorAll('[data-testid="mission-check-criterion"]')] as HTMLElement[];
    expect(items.map(i => i.getAttribute('data-result'))).toEqual(['not checked', 'passed']);
    expect(items[0].textContent).toContain('A queued task waits for a free slot.');
    expect(items[0].textContent).toContain('test file not found');
    expect(items[0].querySelector('[data-testid="mission-check-criterion-id"]')?.textContent).toBe('R-1');
    expect(q('[data-testid="mission-check-state"]')!.textContent).toBe('not checked');
  });

  it('a row without a link or lines draws neither', () => {
    mount([row({ waivable: false })], null);
    expect(q('[data-testid="mission-check-link"]')).toBeNull();
    expect(q('[data-testid="mission-check-criteria"]')).toBeNull();
  });
});

describe('Verify: Requirements and Standards (Navigation R-17, R-18, AC-11)', () => {
  const met = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: `R-${i + from}`, text: `Requirement ${i + from}` }));
  const big: VerifyGroup = {
    key: 'spec-a', specId: 'a', title: 'Cloud runner: deploy from Settings', href: '/app/specs/a?revision=4', scope: null,
    checked: true, checking: false, metCount: 15, total: 18, count: '15 of 18', allMet: false, waived: 0, met: met(15),
    unmet: [
      { id: 'AC-1', text: 'A cloud runner bundle on every release', result: 'Not met', evidence: [{ label: 'Test output', href: '/app/tasks/t1' }],
        action: { kind: 'fixing', taskId: 'r1', title: 'Publish the bundle on release', href: '/app/tasks/r1', detail: 'running 8m', text: 'Fixing: Publish the bundle on release, running 8m' } },
      { id: 'AC-8', text: 'The serving release publishes an image digest', result: "Couldn't tell", evidence: [],
        action: { kind: 'rechecks', taskId: 'r1', title: 'Publish the bundle on release', href: '/app/tasks/r1', detail: null, text: 'rechecks after Publish the bundle on release merges' } },
      { id: 'AC-9', text: 'Settings shows each deploy step as it runs', result: "Couldn't tell", evidence: [{ label: '2 screenshots', href: '/app/missions/m1?visualReview=1' }], action: null },
    ],
  };
  const small: VerifyGroup = {
    key: 'spec-b', specId: 'b', title: 'Settings: Runners', href: '/app/specs/b?revision=2', scope: 'the 3 this mission adds',
    checked: true, checking: false, metCount: 3, total: 3, count: '3 of 3', allMet: true, waived: 0, met: met(3, 40), unmet: [],
  };
  const view: MissionVerifyView = { groups: [big, small], metCount: 18, total: 21, summary: '18 of 21 met', allMet: false };
  const standards: StandardsLine = { text: 'All met', allMet: true, open: false, items: [
    { key: 'ci', label: 'CI', status: 'met', href: null }, { key: 'code-review', label: 'Code review', status: 'met', href: null },
  ] };

  it('reads 18 of 21 met with From <spec> for each group', () => {
    act(() => root.render(<RequirementsView view={view} />));
    expect(q('[data-testid="mission-requirements-summary"]')!.textContent).toBe('18 of 21 met');
    const groups = [...document.querySelectorAll('[data-testid="mission-requirements-group"]')] as HTMLElement[];
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain('From Cloud runner: deploy from Settings');
    expect(groups[0].textContent).toContain('15 of 18');
    expect(groups[0].querySelector('a')!.getAttribute('href')).toBe('/app/specs/a?revision=4');
  });

  it('lists the three unmet with their result, evidence and current action', () => {
    act(() => root.render(<RequirementsView view={view} />));
    const rows = [...document.querySelectorAll('[data-testid="mission-requirement"]')] as HTMLElement[];
    expect(rows.map(r => r.getAttribute('data-result'))).toEqual(['Not met', "Couldn't tell", "Couldn't tell"]);
    expect(rows[0].textContent).toContain('Not met · Test output · Fixing: Publish the bundle on release, running 8m');
    expect((rows[0].querySelector('a[href="/app/tasks/r1"]') as HTMLAnchorElement).textContent).toBe('Publish the bundle on release');
    expect(rows[1].textContent).toContain("Couldn't tell · rechecks after Publish the bundle on release merges");
    expect(rows[2].querySelector('a')!.textContent).toBe('2 screenshots');
  });

  it('folds the met into one row, and an all-met group is one line', () => {
    act(() => root.render(<RequirementsView view={view} />));
    expect(document.querySelectorAll('[data-testid="mission-requirements-met"]')).toHaveLength(1);
    expect(q('[data-testid="mission-requirements-met"] summary')!.textContent).toContain('15 met');
    const allMet = q('[data-testid="mission-requirements-group"][data-all-met="true"]')!;
    expect(allMet.textContent).toBe('From Settings: Runners · the 3 this mission adds✓ 3 of 3');
    expect(allMet.querySelectorAll('[data-testid="mission-requirement"]')).toHaveLength(0);
  });

  it('Standards is one line, closed, opening to CI and code review', () => {
    act(() => root.render(<StandardsLineView line={standards} />));
    const d = q('[data-testid="mission-standards"]') as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(q('[data-testid="mission-standards-summary"]')!.textContent).toBe('✓ All met');
    expect([...document.querySelectorAll('[data-testid="mission-standards-item"]')].map(i => i.textContent)).toEqual(['CI✓ met', 'Code review✓ met']);
  });

  it('a standard not met opens the line on its own, with the failing one in place', () => {
    act(() => root.render(<StandardsLineView line={{ text: '1 not met', allMet: false, open: true, items: [{ key: 'ci', label: 'CI', status: 'not_met', href: null }] }} />));
    expect((q('[data-testid="mission-standards"]') as HTMLDetailsElement).open).toBe(true);
    expect(q('[data-testid="mission-standards-item"]')!.getAttribute('data-status')).toBe('not_met');
  });

  it('no Run verification button, Goal criteria panel or Screens row renders', () => {
    act(() => root.render(<><RequirementsView view={view} /><StandardsLineView line={standards} /></>));
    expect(document.body.textContent).not.toContain('Run verification');
    expect(document.body.textContent).not.toContain('Goal criteria');
    expect(q('[data-testid="mission-criteria-sheet"]')).toBeNull();
    expect(q('[data-testid="mission-screens-row"]')).toBeNull();
  });
});
