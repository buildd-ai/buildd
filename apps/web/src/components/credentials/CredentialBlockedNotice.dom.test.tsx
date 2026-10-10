import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t', width: 1280, height: 800 });

import { afterEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CredentialBlockedNotice } = await import('./CredentialBlockedNotice');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(block: Parameters<typeof CredentialBlockedNotice>[0]['block']) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<CredentialBlockedNotice block={block} />); });
}

describe('CredentialBlockedNotice', () => {
  it('says what is missing and links to add it', async () => {
    await mount({ route: 'claude', scope: 'team' });
    expect(host.textContent).toContain('Needs a Claude key');
    const a = host.querySelector('a')!;
    expect(a.textContent).toBe('Add a Claude key');
    expect(a.getAttribute('href')).toBe('/app/settings/models#keys');
  });

  it('opens the Mine tab under a personal-only policy', async () => {
    await mount({ route: 'codex', scope: 'personal' });
    expect(host.querySelector('a')!.getAttribute('href')).toBe('/app/settings/models?scope=mine#keys');
  });
});
