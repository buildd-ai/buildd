/**
 * Combobox (editable, list autocomplete), mounted in happy-dom at desktop width.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Combobox } = await import('./Combobox');

const MODELS = [
  { value: 'claude-opus-5', label: 'claude-opus-5', group: 'Anthropic' },
  { value: 'claude-sonnet-5', label: 'claude-sonnet-5', group: 'Anthropic' },
  { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex', group: 'OpenAI' },
];

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let changes: string[];
beforeEach(() => {
  changes = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

function Harness({ allowCustom = false }: { allowCustom?: boolean }) {
  const [v, setV] = useState('claude-opus-5');
  return (
    <Combobox
      aria-label="Model"
      value={v}
      allowCustom={allowCustom}
      options={MODELS}
      onChange={(n) => { changes.push(n); setV(n); }}
    />
  );
}

async function mount(el: React.ReactElement) {
  await act(async () => { root.render(el); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const input = () => host.querySelector('input[role="combobox"]') as HTMLInputElement;
const options = () => Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[];
async function key(k: string) {
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
}
async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Combobox', () => {
  it('is an input with list autocomplete that controls a listbox', async () => {
    await mount(<Harness />);
    const el = input();
    expect(el.getAttribute('aria-autocomplete')).toBe('list');
    expect(el.getAttribute('aria-expanded')).toBe('false');
    expect(el.value).toBe('claude-opus-5');
    await key('ArrowDown');
    expect(el.getAttribute('aria-expanded')).toBe('true');
    const lb = document.querySelector('[role="listbox"]')!;
    expect(el.getAttribute('aria-controls')).toBe(lb.id);
    expect(document.getElementById(el.getAttribute('aria-activedescendant')!)!.textContent).toBe('claude-opus-5');
  });

  it('fuzzy-filters across label and group while typing, Enter picks', async () => {
    await mount(<Harness />);
    await type('openai');
    expect(options().map((o) => o.getAttribute('data-value'))).toEqual(['gpt-5.3-codex']);
    await key('Enter');
    expect(changes).toEqual(['gpt-5.3-codex']);
    expect(input().value).toBe('gpt-5.3-codex');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('Escape drops the draft and restores the saved value', async () => {
    await mount(<Harness />);
    await type('son');
    await key('Escape');
    expect(changes).toEqual([]);
    expect(input().value).toBe('claude-opus-5');
  });

  it('without allowCustom, Enter on no match changes nothing', async () => {
    await mount(<Harness />);
    await type('zzz-unknown');
    expect(options().length).toBe(0);
    await key('Enter');
    expect(changes).toEqual([]);
  });

  it('with allowCustom, Enter on no match commits the typed id', async () => {
    await mount(<Harness allowCustom />);
    await type('vendor/new-model');
    expect(document.querySelector('[role="listbox"]')!.textContent).toContain('Enter uses "vendor/new-model"');
    await key('Enter');
    expect(changes).toEqual(['vendor/new-model']);
  });

  it('is square and never falls back to a native datalist', async () => {
    await mount(<Harness />);
    await key('ArrowDown');
    expect(document.querySelector('datalist')).toBeNull();
    expect(input().getAttribute('list')).toBeNull();
    const panel = document.querySelector('[data-popover]')!;
    expect(panel.className).not.toMatch(/rounded/);
    expect(panel.className).toContain('shadow-md');
  });
});
