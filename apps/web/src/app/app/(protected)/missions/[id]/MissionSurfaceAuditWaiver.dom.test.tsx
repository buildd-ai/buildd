/**
 * MissionSurfaceAuditWaiver mounted (happy-dom): the person-only "Waive visual
 * audit" action on the mission page (task 16ccb1b3).
 *
 * - it PATCHes the mission with `{surfaceAuditWaiver: <reason>}` and nothing else,
 *   the existing person-only path that records the reason, the actor and the time;
 * - a reason under the minimum is refused before any request;
 * - a refusal from the server (an agent or task token) is shown, not swallowed;
 * - a recorded waiver shows its reason, who set it and when, and offers no action;
 * - on a mission-branch mission the audit tile says why the audit cannot run
 *   and links the tracking PR.
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
const { default: MissionSurfaceAuditWaiver, MISSION_BRANCH_CAPTURE_URL } = await import('./MissionSurfaceAuditWaiver');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string; body: unknown }[] = [];

function stubFetch(status: number, body: unknown = {}) {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  refreshed = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubFetch(200);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
});

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = async (el: HTMLElement | null) => { await act(async () => { el!.click(); }); await flush(); };

function setReason(text: string) {
  const ta = q('[data-testid="surface-audit-waiver-reason"]') as HTMLTextAreaElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mount(props: Partial<Parameters<typeof MissionSurfaceAuditWaiver>[0]> = {}) {
  await act(async () => {
    root.render(<MissionSurfaceAuditWaiver missionId="m1" waiver={null} missionBranch={false} {...props} />);
  });
  await flush();
}

describe('MissionSurfaceAuditWaiver', () => {
  it('records the reason through the mission PATCH and nothing else', async () => {
    await mount();
    await click(q('[data-action="waive-visual-audit"]'));
    expect(q('[data-testid="surface-audit-waiver-sheet"]')).not.toBeNull();
    setReason('Copy-only change, checked on a phone by hand');
    await click(q('[data-testid="confirm-waive-visual-audit"]'));
    expect(calls).toEqual([{
      url: '/api/missions/m1',
      method: 'PATCH',
      body: { surfaceAuditWaiver: 'Copy-only change, checked on a phone by hand' },
    }]);
    expect(refreshed).toBe(1);
    expect(q('[data-testid="surface-audit-waiver-record"]')?.textContent).toContain('Copy-only change, checked on a phone by hand');
  });

  it('refuses a reason under the minimum without sending anything', async () => {
    await mount();
    await click(q('[data-action="waive-visual-audit"]'));
    setReason('skip');
    await click(q('[data-testid="confirm-waive-visual-audit"]'));
    expect(calls).toHaveLength(0);
    expect(q('[data-testid="surface-audit-waiver-sheet"] [role="alert"]')?.textContent).toContain('10');
  });

  it("shows the server's refusal (an agent or task token cannot waive)", async () => {
    stubFetch(403, { error: 'Only a person can waive the surface audit; an in-task agent cannot' });
    await mount();
    await click(q('[data-action="waive-visual-audit"]'));
    setReason('Not needed, nothing user-facing changed');
    await click(q('[data-testid="confirm-waive-visual-audit"]'));
    expect(q('[data-testid="surface-audit-waiver-sheet"] [role="alert"]')?.textContent).toContain('Only a person can waive');
    expect(refreshed).toBe(0);
    expect(q('[data-testid="surface-audit-waiver-record"]')).toBeNull();
  });

  it('a recorded waiver shows the reason, who and when, and offers no action', async () => {
    await mount({ waiver: { reason: 'Docs-only mission', actorLabel: 'owner@example.com', at: '2026-10-01T12:00:00.000Z' } });
    const rec = q('[data-testid="surface-audit-waiver-record"]')!;
    expect(rec.textContent).toContain('Docs-only mission');
    expect(rec.textContent).toContain('owner@example.com');
    expect(rec.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-01T12:00:00.000Z');
    expect(q('[data-action="waive-visual-audit"]')).toBeNull();
  });

  it('on a mission branch the tile explains why the audit cannot run and links the tracking PR', async () => {
    await mount({ variant: 'tile', missionBranch: true });
    const note = q('[data-testid="surface-audit-mission-branch-note"]')!;
    expect(note.textContent).toContain("can't capture");
    expect(note.querySelector('a')?.getAttribute('href')).toBe(MISSION_BRANCH_CAPTURE_URL);
    expect(q('[data-action="waive-visual-audit"]')).not.toBeNull();
  });

  it('a direct mission tile offers the waiver without the mission-branch note', async () => {
    await mount({ variant: 'tile', missionBranch: false });
    expect(q('[data-testid="surface-audit-mission-branch-note"]')).toBeNull();
    expect(q('[data-action="waive-visual-audit"]')).not.toBeNull();
  });

  it('readonly (a closed mission) offers no action', async () => {
    await mount({ readonly: true });
    expect(q('[data-action="waive-visual-audit"]')).toBeNull();
  });
});
