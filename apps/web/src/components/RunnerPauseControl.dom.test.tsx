import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/health/runners', width: 390, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let status = 200;
let reply: unknown = { ok: true, desiredPause: { paused: true, origin: 'dashboard', setBy: 'Max', setAt: new Date().toISOString() } };
const calls: Array<{ url: string; body: unknown }> = [];
globalThis.fetch = mock(async (url: string, init: RequestInit) => {
  calls.push({ url, body: JSON.parse(String(init.body)) });
  return { ok: status < 300, status, json: async () => reply };
}) as any;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: RunnerPauseControl, pauseView } = await import('./RunnerPauseControl');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); calls.length = 0; status = 200; });

const NOT_HELD = { held: false, desired: null, origin: null, setBy: null, setAt: null };

async function mount(props: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<RunnerPauseControl runnerId="rid-1" active={2} online info={NOT_HELD} canEdit {...props} />);
  });
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => { await act(async () => { q(id)!.click(); }); };

describe('RunnerPauseControl (spec 97b1bd0b R-18, AC-12)', () => {
  it('an owner presses Pause: it is saved with PATCH and reads Paused · 2 finishing once the runner takes it', async () => {
    await mount({});
    expect(q('runner-pause-state')).toBeNull();
    expect(q('runner-pause-toggle')!.textContent).toBe('Pause');
    await click('runner-pause-toggle');
    expect(calls).toEqual([{ url: '/api/runners/rid-1/pause', body: { paused: true } }]);
    expect(q('runner-pause-waiting')!.textContent).toBe('Pause saved. The runner applies it within seconds.');
    expect(q('runner-pause-toggle')!.textContent).toBe('Resume');
    // The runner's next beat reports the hold.
    act(() => root.unmount()); host.remove();
    await mount({ info: { held: true, desired: true, origin: 'dashboard', setBy: 'Max', setAt: new Date().toISOString() } });
    expect(q('runner-pause-state')!.textContent).toBe('Paused · 2 finishing');
    expect(q('runner-pause-waiting')).toBeNull();
    expect(q('runner-pause-origin')!.textContent).toMatch(/^paused on buildd\.dev by Max, \d\d:\d\d$/);
  });

  it('Resume sends paused false', async () => {
    await mount({ active: 0, info: { held: true, desired: true, origin: 'machine', setBy: null, setAt: new Date().toISOString() } });
    expect(q('runner-pause-state')!.textContent).toBe('Paused');
    expect(q('runner-pause-origin')!.textContent).toMatch(/^paused on this machine/);
    reply = { ok: true, desiredPause: { paused: false, origin: 'dashboard', setBy: 'Max', setAt: new Date().toISOString() } };
    await click('runner-pause-toggle');
    expect(calls[0].body).toEqual({ paused: false });
  });

  it('an offline runner\'s Pause is saved and waits for it to check in', async () => {
    await mount({ online: false, info: { held: false, desired: true, origin: 'dashboard', setBy: 'Max', setAt: new Date().toISOString() } });
    expect(q('runner-pause-waiting')!.textContent).toBe('Pause saved. Applies when it checks in.');
    expect(pauseView({ online: false, active: 0, info: { held: false, desired: true, origin: 'dashboard', setBy: 'Max', setAt: new Date().toISOString() } }).chip).toBe('→ Paused on reconnect');
  });

  it('a member sees the state and where it came from, and no button', async () => {
    await mount({ canEdit: false, info: { held: true, desired: true, origin: 'dashboard', setBy: 'Max', setAt: new Date().toISOString() } });
    expect(q('runner-pause-state')!.textContent).toBe('Paused · 2 finishing');
    expect(q('runner-pause-toggle')).toBeNull();
  });

  it('shows the server\'s refusal', async () => {
    status = 403;
    reply = { error: 'Only a team owner or admin can pause a runner.' };
    await mount({});
    await click('runner-pause-toggle');
    expect(q('runner-pause-error')!.textContent).toContain('Only a team owner or admin');
    expect(q('runner-pause-toggle')!.textContent).toBe('Pause');
  });
});
