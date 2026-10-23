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

describe('Skip on a check (R-34, AC-17)', () => {
  it('opens one reason field in place and records the waiver through PATCH surfaceAuditWaiver', async () => {
    mount([row()]);
    expect(q('[data-testid="mission-check-skip-form"]')).toBeNull();
    await act(async () => { q('[data-testid="mission-check-skip"]')!.click(); });
    const input = q('[data-testid="mission-check-skip-reason"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Copy-only change, nothing to see');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (q('[data-testid="mission-check-skip-form"]') as HTMLFormElement).requestSubmit(); });
    await flush();
    expect(calls).toEqual([{ url: '/api/missions/m1', method: 'PATCH', body: { surfaceAuditWaiver: 'Copy-only change, nothing to see' } }]);
    expect(refreshed).toBe(1);
    expect(q('[data-testid="mission-check-skip-form"]')).toBeNull();
  });

  it('a short reason is refused before any request', async () => {
    mount([row()]);
    await act(async () => { q('[data-testid="mission-check-skip"]')!.click(); });
    const input = q('[data-testid="mission-check-skip-reason"]') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'short');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (q('[data-testid="mission-check-skip-form"]') as HTMLFormElement).requestSubmit(); });
    await flush();
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

describe('the stage rail (R-35, AC-18)', () => {
  it('the active stage is the running hue and thicker; none is ink', () => {
    act(() => root.render(<CheckRail steps={[
      { key: 'build', label: 'Build', state: 'done', text: '5 of 5' },
      { key: 'verify', label: 'Verify', state: 'now', text: 'queued' },
      { key: 'deliver', label: 'Deliver', state: 'todo', text: 'into dev' },
    ]} />));
    const bars = Array.from(document.querySelectorAll('[data-testid="mission-check-rail-bar"]')).map(b => b.className);
    expect(bars[1]).toContain('bg-status-running');
    expect(bars[1]).toContain('h-[6px]');
    expect(bars[0]).toContain('h-[3px]');
    expect(bars.join(' ')).not.toContain('bg-text-primary');
  });

  it('held is dashed, so it differs from the active stage by shape, not only hue', () => {
    act(() => root.render(<CheckRail steps={[
      { key: 'build', label: 'Build', state: 'done', text: '5 of 5' },
      { key: 'verify', label: 'Verify', state: 'held', text: 'unable to run' },
      { key: 'deliver', label: 'Deliver', state: 'now', text: 'merging' },
    ]} />));
    const [, held, now] = Array.from(document.querySelectorAll('[data-testid="mission-check-rail-bar"]')).map(b => b.className);
    expect(held).toContain('repeating-linear-gradient');
    expect(now).not.toContain('repeating-linear-gradient');
  });
});

describe('the spec line (Navigation R-3)', () => {
  it('reads Spec <name> linking to the spec, with no revision, status or count', () => {
    act(() => root.render(<OutcomeSpecLines lines={[{ specId: 's1', title: 'Cloud runner: deploy from Settings', revision: 'rev 8', status: 'not checked', href: '/app/specs/s1' }]} />));
    const line = q('[data-testid="mission-outcome-spec"]')!;
    expect(line.textContent).toBe('SpecCloud runner: deploy from Settings');
    expect(line.querySelector('a')!.getAttribute('href')).toBe('/app/specs/s1');
  });

  it('several selected specs read Specs <a>, <b>', () => {
    act(() => root.render(<OutcomeSpecLines lines={[
      { specId: 's1', title: 'Cloud runner: deploy from Settings', revision: 'rev 8', status: 'passed', href: '/app/specs/s1' },
      { specId: 's2', title: 'Settings: Runners', revision: 'rev 2', status: 'not checked', href: '/app/specs/s2' },
    ]} />));
    expect(q('[data-testid="mission-outcome-spec"]')!.textContent).toBe('SpecsCloud runner: deploy from Settings, Settings: Runners');
  });
});

describe('the stage line (Navigation R-15)', () => {
  it('a stage not started is one word; the current and finished stages carry their text', () => {
    act(() => root.render(<CheckRail steps={[
      { key: 'build', label: 'Build', state: 'now', text: '11 of 16 done' },
      { key: 'verify', label: 'Verify', state: 'todo', text: 'after build' },
      { key: 'deliver', label: 'Deliver', state: 'todo', text: 'into dev' },
    ]} />));
    const steps = Array.from(document.querySelectorAll('[data-step]')).map(s => s.textContent);
    expect(steps).toEqual(['Build· 11 of 16 done', 'Verify', 'Deliver']);
  });
});
