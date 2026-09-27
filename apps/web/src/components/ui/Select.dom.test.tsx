/**
 * Select, mounted in happy-dom at desktop width: listbox semantics, keyboard
 * model, typeahead, grouping, search, and the brand surface (square, hard
 * shadow, portaled above dialogs).
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Select } = await import('./Select');

const FRUIT = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana', disabled: true },
  { value: 'blueberry', label: 'Blueberry' },
  { value: 'cherry', label: 'Cherry' },
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
  host.remove();
  document.body.innerHTML = '';
});

function Harness(props: { initial?: string; options?: typeof FRUIT; searchable?: boolean }) {
  const [v, setV] = useState(props.initial ?? 'apple');
  return (
    <Select
      aria-label="Fruit"
      value={v}
      searchable={props.searchable}
      options={props.options ?? FRUIT}
      onChange={(next) => { changes.push(next); setV(next); }}
    />
  );
}

async function mount(el: React.ReactElement) {
  await act(async () => { root.render(el); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const trigger = () => host.querySelector('[role="combobox"]') as HTMLButtonElement;
const listbox = () => document.querySelector('[role="listbox"]') as HTMLElement | null;
const options = () => Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[];
const activeLabel = () => {
  const id = trigger().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent : null;
};

async function key(el: Element, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

describe('Select semantics', () => {
  it('is a combobox button that controls a listbox', async () => {
    await mount(<Harness />);
    const t = trigger();
    expect(t.tagName).toBe('BUTTON');
    expect(t.getAttribute('aria-haspopup')).toBe('listbox');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.getAttribute('aria-label')).toBe('Fruit');
    expect(listbox()).toBeNull();

    await act(async () => { t.click(); });
    expect(t.getAttribute('aria-expanded')).toBe('true');
    const lb = listbox()!;
    expect(t.getAttribute('aria-controls')).toBe(lb.id);
    expect(lb.getAttribute('aria-label')).toBe('Fruit');
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    expect(options()[1].getAttribute('aria-disabled')).toBe('true');
  });

  it('renders no native select', async () => {
    await mount(<Harness />);
    await act(async () => { trigger().click(); });
    expect(document.querySelector('select')).toBeNull();
  });

  it('portals the list to <body> so a card or dialog cannot clip it', async () => {
    await mount(<Harness />);
    await act(async () => { trigger().click(); });
    const panel = listbox()!.closest('[data-popover]')!;
    expect(host.contains(panel)).toBe(false);
    expect(panel.parentElement).toBe(document.body);
    expect(panel.className).toContain('z-[60]');
  });

  it('groups consecutive options under a labelled group', async () => {
    await mount(
      <Harness
        options={[
          { value: 'a', label: 'Opus', group: 'Anthropic' } as never,
          { value: 'b', label: 'Sonnet', group: 'Anthropic' } as never,
          { value: 'c', label: 'GPT', group: 'OpenAI' } as never,
        ]}
        initial="a"
      />,
    );
    await act(async () => { trigger().click(); });
    const groups = Array.from(document.querySelectorAll('[role="group"]'));
    expect(groups.length).toBe(2);
    const label = document.getElementById(groups[0].getAttribute('aria-labelledby')!)!;
    expect(label.textContent).toBe('Anthropic');
    expect(groups[0].querySelectorAll('[role="option"]').length).toBe(2);
  });
});

describe('Select keyboard', () => {
  it('ArrowDown opens on the selected option, then moves past disabled ones', async () => {
    await mount(<Harness />);
    await key(trigger(), 'ArrowDown');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(activeLabel()).toBe('Apple');
    await key(trigger(), 'ArrowDown');
    expect(activeLabel()).toBe('Blueberry');
    await key(trigger(), 'ArrowUp');
    expect(activeLabel()).toBe('Apple');
  });

  it('Home and End jump to the ends', async () => {
    await mount(<Harness />);
    await key(trigger(), 'ArrowDown');
    await key(trigger(), 'End');
    expect(activeLabel()).toBe('Cherry');
    await key(trigger(), 'Home');
    expect(activeLabel()).toBe('Apple');
  });

  it('Enter picks the highlighted option, closes, and keeps focus on the trigger', async () => {
    await mount(<Harness />);
    trigger().focus();
    await key(trigger(), 'Enter');
    await key(trigger(), 'ArrowDown');
    await key(trigger(), 'Enter');
    expect(changes).toEqual(['blueberry']);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
    expect(trigger().textContent).toContain('Blueberry');
  });

  it('Escape closes without changing the value', async () => {
    await mount(<Harness />);
    await key(trigger(), 'ArrowDown');
    await key(trigger(), 'ArrowDown');
    await key(trigger(), 'Escape');
    expect(changes).toEqual([]);
    expect(listbox()).toBeNull();
  });

  it('typeahead jumps to a matching label and cycles on a repeated key', async () => {
    await mount(<Harness />);
    await key(trigger(), 'c');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(activeLabel()).toBe('Cherry');
    await key(trigger(), 'Escape');
    await key(trigger(), 'ArrowDown');
    await key(trigger(), 'b');
    expect(activeLabel()).toBe('Blueberry');
  });

  it('a click on a row picks it; a disabled row does nothing', async () => {
    await mount(<Harness />);
    await act(async () => { trigger().click(); });
    await act(async () => { options()[1].click(); });
    expect(changes).toEqual([]);
    await act(async () => { options()[3].click(); });
    expect(changes).toEqual(['cherry']);
  });

  it('an outside press closes the list', async () => {
    await mount(<Harness />);
    await act(async () => { trigger().click(); });
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(listbox()).toBeNull();
  });
});

describe('Select search', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ value: `m${i}`, label: i === 9 ? 'claude-sonnet-5' : `model-${i}` }));

  it('turns on a search box past ten options and fuzzy-filters', async () => {
    await mount(<Harness options={many} initial="m0" />);
    await act(async () => { trigger().click(); });
    const search = document.querySelector('[role="searchbox"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    expect(document.activeElement).toBe(search);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'son5');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(options().map((o) => o.textContent)).toEqual(['claude-sonnet-5']);
    expect(search.getAttribute('aria-activedescendant')).toBe(options()[0].id);
    await key(search, 'Enter');
    expect(changes).toEqual(['m9']);
  });
});

describe('Select brand surface', () => {
  it('is square with a hard offset shadow and a visible focus ring', async () => {
    await mount(<Harness />);
    await act(async () => { trigger().click(); });
    const t = trigger();
    const panel = listbox()!.closest('[data-popover]')!;
    for (const cls of [t.className, panel.className]) expect(cls).not.toMatch(/rounded/);
    expect(panel.className).toContain('border-2');
    expect(panel.className).toContain('border-border-strong');
    expect(panel.className).toContain('shadow-md');
    expect(t.className).toContain('focus-visible:ring-2');
    expect(t.className).toContain('font-mono');
  });

  it('posts its value through a hidden input when named', async () => {
    await act(async () => {
      root.render(<Select name="fruit" aria-label="Fruit" value="cherry" options={FRUIT} onChange={() => {}} />);
    });
    expect((host.querySelector('input[type="hidden"][name="fruit"]') as HTMLInputElement).value).toBe('cherry');
  });
});
