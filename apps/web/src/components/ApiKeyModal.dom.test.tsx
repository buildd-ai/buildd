import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/runners', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const writeText = mock(async (_: string) => {});
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ApiKeyModal } = await import('./ApiKeyModal');

const KEY = 'bld_fixture_key';
let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
afterEach(() => { act(() => root.unmount()); host.remove(); writeText.mockClear(); });

async function mount(onClose = () => {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<ApiKeyModal open accountName="ci" apiKey={KEY} onClose={onClose} />); });
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
const byText = (t: string) => buttons().find((b) => b.textContent?.trim() === t);

describe('ApiKeyModal', () => {
  it('shows the key once with a single copy action and no MCP setup', async () => {
    await mount();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[data-testid="api-key-value"]')!.textContent).toBe(KEY);
    expect(buttons().filter((b) => b.textContent?.trim() === 'Copy')).toHaveLength(1);
    expect(dialog.textContent).not.toContain('MCP');
    expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('copies only the key and flips that button to Copied', async () => {
    await mount();
    await act(async () => { byText('Copy')!.click(); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(KEY);
    expect(byText('Copied')).toBeDefined();
  });

  it('closes on Done without an acknowledgement step', async () => {
    const onClose = mock(() => {});
    await mount(onClose);
    const done = byText('Done')!;
    expect(done.disabled).toBe(false);
    await act(async () => { done.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
