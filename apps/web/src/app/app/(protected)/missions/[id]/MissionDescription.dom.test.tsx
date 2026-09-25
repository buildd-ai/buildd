/**
 * MissionDescription and MissionInlineEdit, mounted (happy-dom): editing
 * behaviour the static render cannot observe — save on blur, a visible error
 * when the PATCH fails, and re-syncing from props after a server refresh.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionDescription } = await import('./MissionDescription');
const { default: MissionInlineEdit } = await import('./MissionInlineEdit');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; body: unknown }[] = [];

function stubFetch(result: { ok: boolean } | Error) {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (result instanceof Error) throw result;
    return { ok: result.ok } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubFetch({ ok: true });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;

function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function editDescription(value: string) {
  act(() => q('[data-testid="mission-description-edit"]')!.click());
  const ta = q('textarea') as HTMLTextAreaElement;
  act(() => type(ta, value));
  return ta;
}

describe('MissionDescription editing (mounted)', () => {
  it('saves on blur, like the old inline editor', async () => {
    act(() => root.render(<MissionDescription missionId="m1" initialDescription="Old goal." />));
    const ta = editDescription('New goal.');
    await act(async () => { ta.blur(); });
    await flush();
    expect(calls).toEqual([{ url: '/api/missions/m1', body: { description: 'New goal.' } }]);
    expect(q('textarea')).toBeNull();
    expect(container.textContent).toContain('New goal.');
  });

  it('shows an error and keeps the old text when the PATCH is rejected', async () => {
    stubFetch({ ok: false });
    act(() => root.render(<MissionDescription missionId="m1" initialDescription="Old goal." />));
    editDescription('New goal.');
    await act(async () => { q('[data-testid="mission-description-save"]')!.click(); });
    await flush();
    expect(q('[data-testid="mission-description-error"]')?.textContent).toBe('Save failed');
    expect(container.textContent).toContain('Old goal.');
  });

  it('shows an error when the request throws', async () => {
    stubFetch(new Error('offline'));
    act(() => root.render(<MissionDescription missionId="m1" initialDescription="Old goal." />));
    editDescription('New goal.');
    await act(async () => { q('[data-testid="mission-description-save"]')!.click(); });
    await flush();
    expect(q('[data-testid="mission-description-error"]')?.textContent).toBe('Save failed');
  });

  it('Cancel discards the draft without saving', async () => {
    act(() => root.render(<MissionDescription missionId="m1" initialDescription="Old goal." />));
    editDescription('New goal.');
    await act(async () => { q('[data-testid="mission-description-cancel"]')!.click(); });
    await flush();
    expect(calls).toEqual([]);
    expect(container.textContent).toContain('Old goal.');
  });

  it('re-syncs from props after a refresh while not editing', () => {
    act(() => root.render(<MissionDescription missionId="m1" initialDescription="Old goal." />));
    act(() => root.render(<MissionDescription missionId="m1" initialDescription="Changed elsewhere." />));
    expect(container.textContent).toContain('Changed elsewhere.');
  });

  it('does not clobber an open draft when props change', () => {
    act(() => root.render(<MissionDescription missionId="m1" initialDescription="Old goal." />));
    editDescription('My draft.');
    act(() => root.render(<MissionDescription missionId="m1" initialDescription="Changed elsewhere." />));
    expect((q('textarea') as HTMLTextAreaElement).value).toBe('My draft.');
  });
});

describe('MissionInlineEdit (mounted)', () => {
  it('prefills Rename with a title changed elsewhere', () => {
    act(() => root.render(<MissionInlineEdit missionId="m1" initialTitle="Old title" />));
    act(() => root.render(<MissionInlineEdit missionId="m1" initialTitle="New title" />));
    act(() => q('[data-testid="mission-rename"]')!.click());
    expect((q('input') as HTMLInputElement).value).toBe('New title');
  });
});
