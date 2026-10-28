import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/health/runners', width: 390, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let status = 200;
let reply: unknown = { ok: true, desiredSlots: { slots: 8, origin: 'dashboard', setBy: 'Max', setAt: new Date(2026, 9, 22, 14, 2).toISOString() } };
const calls: Array<{ url: string; body: unknown }> = [];
globalThis.fetch = mock(async (url: string, init: RequestInit) => {
  calls.push({ url, body: JSON.parse(String(init.body)) });
  return { ok: status < 300, status, json: async () => reply };
}) as any;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: RunnerSlotsControl, slotsView } = await import('./RunnerSlotsControl');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); calls.length = 0; status = 200; });

async function mount(props: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<RunnerSlotsControl runnerId="rid-1" active={9} reported={12} online info={null} canEdit {...props} />);
  });
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => { await act(async () => { q(id)!.click(); }); };

describe('RunnerSlotsControl', () => {
  it('says how many are busy and where the number came from', async () => {
    await mount({ info: { desired: 12, origin: 'dashboard', setBy: 'Max', setAt: new Date().toISOString() } });
    expect(q('runner-slots-busy')!.textContent).toBe('9 of 12 slots in use');
    expect(q('runner-slots-origin')!.textContent).toMatch(/12 slots · set on buildd\.dev by Max, \d\d:\d\d/);
    expect(q('runner-slots-waiting')).toBeNull();
  });

  it('steps, shows a save button only when the number moved, and saves with PATCH', async () => {
    await mount({});
    expect(q('runner-slots-save')).toBeNull();
    await click('runner-slots-minus'); await click('runner-slots-minus'); await click('runner-slots-minus'); await click('runner-slots-minus');
    expect(q('runner-slots-draft')!.textContent).toBe('8');
    expect(q('runner-slots-save')!.textContent).toBe('Set to 8');
    await click('runner-slots-save');
    expect(calls).toEqual([{ url: '/api/runners/rid-1/slots', body: { slots: 8 } }]);
    // Online: saved and taken on the next check-in; the draft no longer differs, so no save button.
    expect(q('runner-slots-waiting')!.textContent).toContain('Saving 8 slots. The runner applies it within seconds.');
    expect(q('runner-slots-waiting')!.textContent).not.toContain('Applies when it checks in');
    expect(q('runner-slots-save')).toBeNull();
  });

  it('an offline runner\'s change is saved and labelled as waiting for it to check in', async () => {
    await mount({ online: false });
    await click('runner-slots-minus'); await click('runner-slots-minus'); await click('runner-slots-minus'); await click('runner-slots-minus');
    await click('runner-slots-save');
    expect(q('runner-slots-waiting')!.textContent).toBe('Saved: 8 slots. Applies when it checks in.');
  });

  it('stays within 0 to 50', async () => {
    await mount({ reported: 0, active: 0 });
    expect((q('runner-slots-minus') as HTMLButtonElement).disabled).toBe(true);
    act(() => root.unmount()); host.remove();
    await mount({ reported: 50, active: 0 });
    expect((q('runner-slots-plus') as HTMLButtonElement).disabled).toBe(true);
  });

  it('steps down to 0 and saves it: the runner claims nothing (spec 97b1bd0b AC-12)', async () => {
    reply = { ok: true, desiredSlots: { slots: 0, origin: 'dashboard', setBy: 'Max', setAt: new Date().toISOString() } };
    await mount({ reported: 1, active: 0 });
    await click('runner-slots-minus');
    expect(q('runner-slots-draft')!.textContent).toBe('0');
    await click('runner-slots-save');
    expect(calls).toEqual([{ url: '/api/runners/rid-1/slots', body: { slots: 0 } }]);
    expect(q('runner-slots-waiting')!.textContent).toBe('Saving 0 slots. The runner applies it within seconds.');
  });

  it('a member sees the number and where it came from, and no control', async () => {
    await mount({ canEdit: false, info: { desired: 12, origin: 'machine', setBy: null, setAt: new Date().toISOString() } });
    expect(q('runner-slots-origin')!.textContent).toContain('set on this machine');
    expect(q('runner-slots-minus')).toBeNull();
    expect(q('runner-slots-plus')).toBeNull();
  });

  it('shows the server\'s refusal and keeps the draft', async () => {
    status = 403;
    reply = { error: 'Only a team owner or admin can change a runner\'s slots.' };
    await mount({});
    await click('runner-slots-plus');
    await click('runner-slots-save');
    expect(q('runner-slots-error')!.textContent).toContain('Only a team owner or admin');
    expect(q('runner-slots-draft')!.textContent).toBe('13');
  });

  it('says so in words when more agents run than the lowered slots', () => {
    const v = slotsView({ active: 9, reported: 6, online: true, info: null });
    expect(v.busy).toBe('9 running on 6 slots');
  });
});
