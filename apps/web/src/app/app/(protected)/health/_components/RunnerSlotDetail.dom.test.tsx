import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/health/runners', width: 390, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

globalThis.fetch = mock(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, desiredSlots: { slots: 6, origin: 'dashboard', setBy: 'Max', setAt: new Date().toISOString() } }),
})) as any;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: RunnerSlotDetail } = await import('./RunnerSlotDetail');

const NOW = Date.now();
const runner = {
  id: 'r1',
  maxConcurrentWorkers: 5,
  activeWorkerCount: 0,
  lastHeartbeatAt: new Date(NOW).toISOString(),
  slots: { desired: 5, origin: 'dashboard', setBy: 'Max', setAt: new Date(NOW).toISOString(), canEdit: true },
} as any;

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(props: Record<string, unknown> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <RunnerSlotDetail
        fleetRow={null}
        runner={runner}
        online
        lastHeartbeatAt={runner.lastHeartbeatAt}
        now={NOW}
        seesTeamWork
        ownerLabel="personal"
        route={{ claude: 'api', codex: 'api' }}
        {...props}
      />,
    );
  });
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => { await act(async () => { q(id)!.click(); }); };

describe('RunnerSlotDetail AC-10: stepping 5 to 6', () => {
  it('online: Saving 6 slots, the runner applies it within seconds', async () => {
    await mount();
    await click('runner-slots-plus');
    await click('runner-slots-save');
    expect(q('runner-slots-waiting')!.textContent).toBe('Saving 6 slots. The runner applies it within seconds.');
  });

  it('offline: Saved: 6 slots, applies when it checks in', async () => {
    await mount({ online: false });
    await click('runner-slots-plus');
    await click('runner-slots-save');
    expect(q('runner-slots-waiting')!.textContent).toBe('Saved: 6 slots. Applies when it checks in.');
  });
});
