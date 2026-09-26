/**
 * ProviderKeyCard, mounted in happy-dom. Covers the write-only contract (the
 * masked value shows, the pasted key never does), the subscription-token guard,
 * confirm-before-remove, and the read-only member view. Fixtures are
 * illustrative; nothing here is a real key.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ProviderKeyCard, KeyPrecedenceNote } = await import('./ProviderKeyCard');
const { CHAT_PROVIDER_INFO, toKeyStatus } = await import('@/lib/provider-keys-client');

const ANTHROPIC = CHAT_PROVIDER_INFO[0];
const NOW = new Date('2026-09-26T12:00:00Z');
const SET_KEY = toKeyStatus({
  id: 'k1', provider: 'anthropic', scope: 'team', last4: '4f2a', health: 'healthy',
  lastVerifiedAt: '2026-09-26T10:00:00Z', lastVerificationError: null,
  updatedAt: '2026-09-26T10:00:00Z', source: 'inference_key',
});
const RUNNER_KEY = toKeyStatus({
  id: 'k9', provider: 'anthropic', scope: 'team', last4: '0c0c', health: 'healthy',
  lastVerifiedAt: null, lastVerificationError: null,
  updatedAt: '2026-09-26T10:00:00Z', source: 'anthropic_api_key',
});
const UNSET = null;

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const onSave = mock(async (_v: string) => SET_KEY);
const onRemove = mock(async () => {});
const onTest = mock(async () => ({ ok: true, error: null as string | null }));

function render(props: Partial<Parameters<typeof ProviderKeyCard>[0]> = {}) {
  act(() => root.render(
    <ProviderKeyCard
      info={ANTHROPIC}
      status={SET_KEY}
      mode="team"
      ownKeyCount={1}
      canEdit
      onSave={onSave}
      onRemove={onRemove}
      onTest={onTest}
      now={NOW}
      {...props}
    />,
  ));
}

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(b: HTMLButtonElement | undefined) {
  expect(b).toBeDefined();
  await act(async () => { b!.click(); });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onSave.mockClear();
  onRemove.mockClear();
  onTest.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('ProviderKeyCard', () => {
  it('shows the masked team key, when it was checked, and how many members use their own', () => {
    render();
    expect(host.textContent).toContain('…4f2a');
    expect(host.textContent).toContain('checked 2h ago');
    expect(host.textContent).toContain('1 member');
    expect(host.querySelector('[data-testid="provider-key-health"]')?.textContent).toBe('working');
  });

  it('adds a key: sends the sanitized value and clears it from the form', async () => {
    render({ status: UNSET });
    await click(button('Add team key'));
    const input = host.querySelector('input[type="password"]') as HTMLInputElement;
    type(input, '  "sk-ant-api03-example"  ');
    await click(button('Save key'));

    expect(onSave).toHaveBeenCalledWith('sk-ant-api03-example');
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.textContent).not.toContain('sk-ant-api03-example');
    expect(host.textContent).toContain('Anthropic accepted the key');
  });

  it('refuses a Claude subscription token before it reaches the server', async () => {
    render({ status: UNSET });
    await click(button('Add team key'));
    type(host.querySelector('input[type="password"]') as HTMLInputElement, 'sk-ant-oat01-example');

    expect(host.textContent).toMatch(/subscription token/);
    expect(button('Save key')?.disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('asks before removing a key', async () => {
    render();
    await click(button('Remove'));
    expect(onRemove).not.toHaveBeenCalled();
    expect(host.textContent).toMatch(/lose chat/);
    await click(button('Confirm remove'));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('tests the key and reports a rejection', async () => {
    onTest.mockImplementationOnce(async () => ({ ok: false, error: 'HTTP 401: invalid x-api-key' }));
    render();
    await click(button('Test key'));
    expect(onTest).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('HTTP 401');
  });

  it('is read-only for someone who cannot edit', () => {
    render({ canEdit: false });
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.textContent).toContain('…4f2a');
  });

  it('surfaces a save the provider refused', async () => {
    onSave.mockImplementationOnce(async () => { throw new Error('The provider rejected this key. HTTP 401'); });
    render({ status: UNSET });
    await click(button('Add team key'));
    type(host.querySelector('input[type="password"]') as HTMLInputElement, 'sk-ant-api03-example-example');
    await click(button('Save key'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('rejected');
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('shows a key set elsewhere without offering to change it here', () => {
    render({ status: RUNNER_KEY });
    expect(host.textContent).toContain('…0c0c');
    expect(host.textContent).toMatch(/Agent backends/);
    expect(button('Remove')).toBeUndefined();
    expect(button('Replace')).toBeUndefined();
  });

  it('personal mode offers "Use my own key" and says which key chat uses', () => {
    render({ mode: 'personal', status: UNSET, inUse: 'the team key' });
    expect(button('Use my own key')).toBeDefined();
    expect(host.querySelector('[data-testid="provider-key-in-use"]')?.textContent).toBe('the team key');
  });
});

describe('KeyPrecedenceNote', () => {
  it('lists your key, then workspace, then team, with no em dashes', () => {
    act(() => root.render(<KeyPrecedenceNote mode="team" />));
    const items = [...host.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual(['Your own key', 'The workspace key', 'The team key (set here)']);
    expect(host.textContent).not.toContain('—');
  });
});
