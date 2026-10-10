import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/team', width: 1024, height: 768 });
import { afterEach, expect, it, mock } from 'bun:test';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: WarmHandoverSection } = await import('./WarmHandoverSection');
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function mount(props: any) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<WarmHandoverSection {...props} />); });
}
it('loads team policy and saves a chosen mode', async () => {
  const calls: any[] = [];
  globalThis.fetch = mock(async (url: any, options: any) => {
    calls.push([url, options]);
    return new Response(JSON.stringify(options ? { success: true } : { team: { warmHandover: 'repo' } }));
  }) as any;
  await mount({ teamId: 'team-fixture' });
  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="warm-handover-select"]')!;
  expect(trigger.textContent).toContain('Repository');
  await act(async () => { trigger.click(); });
  const option = document.querySelector<HTMLElement>('[role="option"][data-value="deps"]') ?? [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(x => x.textContent?.includes('Verified dependencies'))!;
  await act(async () => { option.click(); });
  expect(JSON.parse(calls.at(-1)[1].body)).toEqual({ warmHandover: 'deps' });
});
it('shows inherited team policy and respects read-only access', async () => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ team: { warmHandover: 'deps' } }))) as any;
  await mount({ teamId: 'team-fixture', workspaceId: 'workspace-fixture', canEdit: false });
  expect(host.textContent).toContain('Team default: Verified dependencies');
  expect(host.querySelector<HTMLButtonElement>('[data-testid="warm-handover-select"]')!.disabled).toBe(true);
});
