/**
 * The workspace's Visual Review policy (gitConfig.visualReview.policy). Runs in
 * its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 390, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: VisualReviewPolicySection } = await import('./VisualReviewPolicySection');

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
const effective = () => host.querySelector('[data-testid="visual-review-effective"]')!.textContent ?? '';

const render = (props: Partial<{ override: 'strict' | 'automatic' | 'ask' | 'off' | null; inherited: { mode: 'strict' | 'automatic' | 'ask' | 'off'; origin: 'default' | 'team' }; canEdit: boolean }> = {}) =>
  act(() => root.render(
    <VisualReviewPolicySection workspaceId="ws-1" override={props.override ?? null} inherited={props.inherited ?? { mode: 'automatic', origin: 'default' }} canEdit={props.canEdit ?? true} />,
  ));

describe('VisualReviewPolicySection', () => {
  it('shows the inherited value and its origin when there is no override', () => {
    render();
    expect(radio('Inherit').getAttribute('aria-checked')).toBe('true');
    expect(effective()).toContain('Automatic');
    expect(effective()).toContain('default');
  });

  it('names the team as the origin when the team sets it', () => {
    render({ inherited: { mode: 'ask', origin: 'team' } });
    expect(effective()).toContain('Ask');
    expect(effective()).toContain('team');
  });

  it('shows a workspace override as set here', () => {
    render({ override: 'strict' });
    expect(radio('Strict').getAttribute('aria-checked')).toBe('true');
    expect(effective()).toContain('Strict');
    expect(effective()).toContain('this workspace');
  });

  it('saves an override', async () => {
    render();
    await act(async () => { radio('Ask').click(); });
    await act(async () => { submit().click(); });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspaces/ws-1/config');
    expect(init.method).toBe('PATCH');
    expect(body()).toEqual({ visualReview: { policy: 'ask' } });
  });

  it('saves Inherit as null so the override is cleared', async () => {
    render({ override: 'off' });
    await act(async () => { radio('Inherit').click(); });
    await act(async () => { submit().click(); });
    expect(body()).toEqual({ visualReview: null });
  });

  it('explains strict forbids skipping', async () => {
    render({ override: 'strict' });
    expect(host.textContent).toContain('cannot be skipped');
  });

  it('is read-only without edit rights', () => {
    render({ canEdit: false, override: 'ask' });
    expect(host.querySelector('[role="radio"]')).toBeNull();
    expect(effective()).toContain('Ask');
  });
});
