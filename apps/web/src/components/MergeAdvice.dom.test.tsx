import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/home', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { MergeAdviceSlot, MergeAdviceView } from '@/lib/merge-advice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MergeAdvice } = await import('./MergeAdvice');

let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
const realFetch = globalThis.fetch;
afterEach(() => { act(() => root.unmount()); host.remove(); globalThis.fetch = realFetch; });

const view = (over: Partial<MergeAdviceView> = {}): MergeAdviceView => ({
  decision: 'needs_human', source: 'model', line: 'Needs your judgement: migration.', at: new Date().toISOString(), stale: null, ...over,
});
const slot = (over: Partial<MergeAdviceSlot> = {}): MergeAdviceSlot => ({
  prNumber: 7, workspaceId: 'ws-1', advice: null, token: 'signed', unavailable: null, ...over,
});

async function mount(s: MergeAdviceSlot) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<MergeAdvice slot={s} />); });
}
const line = () => document.querySelector('[data-testid="merge-advice-line"]');
const ask = () => document.querySelector<HTMLButtonElement>('[data-testid="merge-advice-ask"]');

describe('MergeAdvice', () => {
  it('shows a current answer inline, with its source and age, and no button', async () => {
    await mount(slot({ advice: view() }));
    expect(line()?.textContent).toContain('Needs your judgement: migration.');
    expect(line()?.textContent).toContain('Jev · just now');
    expect(ask()).toBeNull();
  });

  it('labels a rule answer as coming from the PR state', async () => {
    await mount(slot({ advice: view({ source: 'rule', decision: 'wait', line: 'Wait: CI is still running.' }) }));
    expect(line()?.textContent).toContain('From the PR state');
  });

  it('dims an answer for an older head and offers Re-assess', async () => {
    await mount(slot({ advice: view({ stale: 'new_commits' }) }));
    expect(line()?.getAttribute('data-stale')).toBe('new_commits');
    expect(line()?.textContent).toContain('new commits since');
    expect(ask()?.textContent).toBe('Re-assess');
  });

  it('offers Ask Jev when there is no answer, and renders the result', async () => {
    const fetchMock = mock(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ kind: 'answer', reused: false, advice: view({ decision: 'merge_now', line: 'Looks safe to merge: CI is green and the review covers this commit.' }) }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await mount(slot());
    expect(ask()?.textContent).toBe('Ask Jev');
    await act(async () => { ask()!.click(); });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/prs/7/merge-readiness');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ workspaceId: 'ws-1', token: 'signed' });
    expect(line()?.textContent).toContain('Looks safe to merge');
    expect(ask()).toBeNull();
  });

  it('disables the button with the reason when Jev is unavailable', async () => {
    await mount(slot({ token: null, unavailable: 'This server cannot sign the request.' }));
    expect(ask()?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="merge-advice-unavailable"]')?.textContent).toBe('This server cannot sign the request.');
  });

  it('turns an unavailable answer from the route into a disabled button with its reason', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ kind: 'unavailable', reason: 'This team has no decision-model key.' }), { status: 200 })) as unknown as typeof fetch;
    await mount(slot());
    await act(async () => { ask()!.click(); });
    expect(ask()?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="merge-advice-unavailable"]')?.textContent).toBe('This team has no decision-model key.');
  });
});
