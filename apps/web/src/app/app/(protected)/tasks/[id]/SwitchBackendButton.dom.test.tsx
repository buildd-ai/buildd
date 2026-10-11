import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SwitchBackendButton } = await import('./SwitchBackendButton');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(options: Parameters<typeof SwitchBackendButton>[0]['options']) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<SwitchBackendButton taskId="t" options={options} />); });
}

describe('SwitchBackendButton', () => {
  it('a provider with no key is a link to add one, where the task is blocked', async () => {
    await mount([{ backend: 'codex', label: 'Codex', available: false, blockedReason: 'no credential configured', addKeyHref: '/app/settings/models#keys' }]);
    const a = host.querySelector('a')!;
    expect(a.textContent).toBe('Add a Codex key');
    expect(a.getAttribute('href')).toBe('/app/settings/models#keys');
    expect(host.textContent).not.toContain('no credential configured');
  });

  it('a rate-limited provider still says why, with no link', async () => {
    await mount([{ backend: 'codex', label: 'Codex', available: false, blockedReason: 'rate-limited until 20:00 UTC' }]);
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toContain('Codex unavailable: rate-limited until 20:00 UTC');
  });
});
