/**
 * Select and Combobox on a phone (390px): both open as the shared bottom sheet
 * with 48px rows instead of an anchored popover.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Select } = await import('./Select');
const { Combobox } = await import('./Combobox');

const OPTS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
];

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

async function mount(el: React.ReactElement) {
  await act(async () => { root.render(el); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('phone sheet', () => {
  it('Select opens a modal bottom sheet titled by its label, with tall rows', async () => {
    const picked: string[] = [];
    await mount(<Select aria-label="Team" value="a" options={OPTS} onChange={(v) => picked.push(v)} />);
    await act(async () => { (host.querySelector('[role="combobox"]') as HTMLElement).click(); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Team');
    const rows = Array.from(dialog.querySelectorAll('[role="option"]')) as HTMLElement[];
    expect(rows.length).toBe(2);
    expect(rows[0].className).toContain('min-h-12');
    expect(rows[0].className).toContain('text-base');
    await act(async () => { rows[1].click(); });
    expect(picked).toEqual(['b']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Select trigger is a 44px target with 16px text below md', async () => {
    await mount(<Select aria-label="Team" value="a" options={OPTS} onChange={() => {}} />);
    const cls = (host.querySelector('[role="combobox"]') as HTMLElement).className;
    expect(cls).toContain('min-h-11');
    expect(cls).toContain('text-base');
  });

  it('a searchable Select opens a tall sheet so the search box stays put while the list scrolls', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ value: `z${i}`, label: `Zone ${i}` }));
    await mount(<Select aria-label="Team timezone" value="z29" options={many} onChange={() => {}} />);
    await act(async () => { (host.querySelector('[role="combobox"]') as HTMLElement).click(); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.className).toContain('h-[88dvh]');
    const search = dialog.querySelector('[role="searchbox"]')!;
    const list = dialog.querySelector('[role="listbox"]')!;
    expect(list.contains(search)).toBe(false);
    expect(list.className).toContain('overflow-y-auto');
  });

  it('Combobox opens a sheet with its own search box', async () => {
    await mount(<Combobox aria-label="Model" value="a" options={OPTS} onChange={() => {}} />);
    const t = host.querySelector('[role="combobox"]') as HTMLElement;
    expect(t.tagName).toBe('BUTTON');
    await act(async () => { t.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const dialog = document.querySelector('[role="dialog"]')!;
    const search = dialog.querySelector('input[role="combobox"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    expect(search.className).toContain('text-base');
    expect(document.activeElement).toBe(search);
  });
});
