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
const { ChecksCard, CheckRail, OutcomeSpecLines } = await import('./MissionChecks');
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
