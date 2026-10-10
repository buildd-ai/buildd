/**
 * The workspace's copy review (gitConfig.copyReview). Runs in its own process
 * (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CopyReviewSection } = await import('./CopyReviewSection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof mock>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = mock(async () => new Response('{}', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

const radio = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === name)!;
const submit = () => host.querySelector('button[type="submit"]') as HTMLButtonElement;
const body = () => JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));

describe('CopyReviewSection', () => {
  it('shows Off when the workspace has none', () => {
    act(() => root.render(<CopyReviewSection workspaceId="ws-1" initial={null} canEdit={true} />));
    expect(radio('Off').getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('input[name="voiceGuide"]')).toBeNull();
  });

  it('saves Required with the voice guide and lint command', async () => {
    act(() => root.render(<CopyReviewSection workspaceId="ws-1" initial={null} canEdit={true} />));
    await act(async () => { radio('Required').click(); });
    const guide = host.querySelector('input[name="voiceGuide"]') as HTMLInputElement;
    expect(guide).not.toBeNull();
    await act(async () => { submit().click(); });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspaces/ws-1/config');
    expect(init.method).toBe('PATCH');
    expect(body().copyReview.mode).toBe('gate');
    expect(typeof body().copyReview.voiceGuide).toBe('string');
  });

  it('saves Off as null', async () => {
    act(() => root.render(<CopyReviewSection workspaceId="ws-1" initial={{ voiceGuide: 'VOICE.md', mode: 'review' }} canEdit={true} />));
    expect(radio('Comments').getAttribute('aria-checked')).toBe('true');
    await act(async () => { radio('Off').click(); });
    await act(async () => { submit().click(); });
    expect(body()).toEqual({ copyReview: null });
  });

  it('cannot be changed by someone who cannot edit the workspace', () => {
    act(() => root.render(<CopyReviewSection workspaceId="ws-1" initial={null} canEdit={false} />));
    expect(submit()).toBeNull();
  });
});
