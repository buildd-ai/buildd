/**
 * Verify's Re-verify control mounted (happy-dom): idle offers the button,
 * a click files the batched check run and the control reads queued, then
 * running; a queued or running run disables it (the server is idempotent
 * anyway). Runs in its own process, so the DOM globals stay here.
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
const { default: ReverifyButton } = await import('./ReverifyButton');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string }[] = [];
let reply: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { taskId: 't1', headSha: 'a'.repeat(40), state: 'queued', filed: true } };

beforeEach(() => {
  refreshed = 0; calls = [];
  reply = { ok: true, status: 200, body: { taskId: 't1', headSha: 'a'.repeat(40), state: 'queued', filed: true } };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return { ok: reply.ok, status: reply.status, json: async () => reply.body } as Response;
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
const button = () => document.querySelector('[data-testid="mission-reverify"]') as HTMLButtonElement;

describe('ReverifyButton', () => {
  it('idle: offers Re-verify, enabled', () => {
    act(() => root.render(<ReverifyButton missionId="m1" state="idle" />));
    expect(button().textContent).toBe('Re-verify');
    expect(button().disabled).toBe(false);
    expect(button().getAttribute('data-state')).toBe('idle');
  });

  it('click files the run once and then reads queued, disabled', async () => {
    act(() => root.render(<ReverifyButton missionId="m1" state="idle" />));
    await act(async () => { button().click(); });
    await flush();
    expect(calls).toEqual([{ url: '/api/missions/m1/verify', method: 'POST' }]);
    expect(button().getAttribute('data-state')).toBe('queued');
    expect(button().disabled).toBe(true);
    expect(refreshed).toBe(1);
  });

  it('queued: reads Queued and cannot be pressed again', () => {
    act(() => root.render(<ReverifyButton missionId="m1" state="queued" />));
    expect(button().textContent).toBe('Queued');
    expect(button().disabled).toBe(true);
  });

  it('running: reads Checking and is disabled', () => {
    act(() => root.render(<ReverifyButton missionId="m1" state="running" />));
    expect(button().textContent).toBe('Checking');
    expect(button().disabled).toBe(true);
  });

  it('a refusal shows its reason and returns to idle', async () => {
    reply = { ok: false, status: 409, body: { error: 'No integrated target to verify against yet' } };
    act(() => root.render(<ReverifyButton missionId="m1" state="idle" />));
    await act(async () => { button().click(); });
    await flush();
    expect(button().getAttribute('data-state')).toBe('idle');
    expect(document.querySelector('[data-testid="mission-reverify-error"]')?.textContent).toContain('No integrated target');
  });

  it('follows the server state when the page refreshes', () => {
    act(() => root.render(<ReverifyButton missionId="m1" state="queued" />));
    act(() => root.render(<ReverifyButton missionId="m1" state="running" />));
    expect(button().getAttribute('data-state')).toBe('running');
    act(() => root.render(<ReverifyButton missionId="m1" state="idle" />));
    expect(button().getAttribute('data-state')).toBe('idle');
  });
});
