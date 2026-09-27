/**
 * CatalogModelPicker, mounted in happy-dom at desktop width. Catalog fixtures
 * are illustrative, not a capture.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 1440, height: 900 });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { CatalogModelPicker } = await import('./CatalogModelPicker');
const { TIER_ROUTES, ARM_ROUTE_SPECS } = await import('@/lib/model-picker');

const T = (iso: string) => Date.parse(iso) / 1000;
const or = (vendor: string, slug: string, input: number, output: number, created: string) => ({
  id: slug, provider: vendor === 'anthropic' ? 'anthropic' : vendor === 'openai' ? 'openai' : 'other',
  openRouterId: `${vendor}/${slug}`, vendor, inputPrice: input, outputPrice: output, contextLength: 1_000_000, created: T(created),
});
const MODELS = [
  or('anthropic', 'claude-sonnet-5', 2, 10, '2026-06-30'),
  or('anthropic', 'claude-opus-5', 5, 25, '2026-07-15'),
  or('anthropic', 'claude-haiku-4-5', 1, 5, '2025-10-01'),
  or('openai', 'gpt-5.6-terra', 2.5, 15, '2026-08-01'),
  or('google', 'gemini-3-pro', 2, 12, '2026-05-01'),
  or('google', 'gemini-3-flash', 0.5, 3, '2026-05-01'),
  or('deepseek', 'deepseek-v4-pro', 1.6, 3.2, '2026-08-10'),
  ...['qwen3-coder', 'qwen3.6-max', 'qwen3-235b', 'qwen3-32b', 'qwen3-next'].map((q, i) => or('qwen', q, 1.6 + i * 0.1, 6, `2026-0${i + 1}-10`)),
];

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let picks: unknown[];
beforeEach(() => {
  picks = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

function Single() {
  const [v, setV] = useState<{ route: string; model: string } | null>({ route: 'anthropic', model: 'claude-sonnet-5' });
  return <CatalogModelPicker aria-label="Model for standard" tier="standard" routes={TIER_ROUTES} models={MODELS} value={v} onChange={(n) => { picks.push(n); setV(n); }} />;
}

async function mount(el: React.ReactElement) {
  await act(async () => { root.render(el); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const trigger = () => host.querySelector('[data-testid="model-picker-trigger"]') as HTMLButtonElement;
const search = () => document.querySelector('[data-testid="model-picker-search"]') as HTMLInputElement;
const rowEls = () => Array.from(document.querySelectorAll('[data-testid="model-picker-row"]')) as HTMLElement[];
const rowKeys = () => rowEls().map((r) => r.getAttribute('data-key'));
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };
async function key(k: string, opts: KeyboardEventInit = {}) {
  await act(async () => { search().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts })); });
}
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), text);
    search().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('CatalogModelPicker, single', () => {
  it('shows the current model on a combobox trigger that controls a listbox', async () => {
    await mount(<Single />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger().textContent).toContain('claude-sonnet-5');
    expect(trigger().textContent).toContain('Anthropic key');
    await click(trigger());
    const lb = document.querySelector('[role="listbox"]')!;
    expect(trigger().getAttribute('aria-controls')).toBe(lb.id);
    expect(search().getAttribute('aria-controls')).toBe(lb.id);
    expect(document.activeElement).toBe(search());
  });

  it('groups by the key that pays, then by vendor inside OpenRouter', async () => {
    await mount(<Single />);
    await click(trigger());
    const groups = Array.from(document.querySelectorAll('[role="listbox"] > [role="group"]'));
    expect(groups.map((g) => document.getElementById(g.getAttribute('aria-labelledby')!)!.textContent)).toEqual([
      expect.stringContaining('Anthropic key'), expect.stringContaining('OpenAI key'),
      expect.stringContaining('OpenRouter key'), expect.stringContaining('Runner · Codex'),
    ]);
    const orGroup = groups[2];
    const vendors = Array.from(orGroup.querySelectorAll('[data-vendor]')).map((m) => m.getAttribute('data-vendor'));
    expect([...new Set(vendors)]).toEqual(['anthropic', 'openai', 'google', 'deepseek', 'qwen']);
  });

  it('defaults to the tier band, badges current and recommended, and shows every price on request', async () => {
    await mount(<Single />);
    await click(trigger());
    const anthropic = rowKeys().filter((k) => k!.startsWith('anthropic::'));
    expect(anthropic).toEqual(['anthropic::claude-sonnet-5']);
    const sonnet = rowEls().find((r) => r.getAttribute('data-key') === 'anthropic::claude-sonnet-5')!;
    expect(sonnet.getAttribute('aria-selected')).toBe('true');
    expect(Array.from(sonnet.querySelectorAll('[data-badge]')).map((b) => b.getAttribute('data-badge'))).toEqual(['current', 'recommended']);
    await click(document.querySelector('[data-testid="model-picker-band-all"]'));
    expect(rowKeys().filter((k) => k!.startsWith('anthropic::'))).toEqual([
      'anthropic::claude-sonnet-5', 'anthropic::claude-opus-5', 'anthropic::claude-haiku-4-5',
    ]);
  });

  it('folds a vendor after three rows and expands from the "+N more" row', async () => {
    await mount(<Single />);
    await click(trigger());
    expect(rowKeys().filter((k) => k!.includes('qwen/')).length).toBe(3);
    const more = document.querySelector('[data-testid="model-picker-more"]')!;
    expect(more.textContent).toContain('2 more Qwen');
    await click(more);
    expect(rowKeys().filter((k) => k!.includes('qwen/')).length).toBe(5);
  });

  it('fuzzy search, arrows and Enter pick a (route, model) pair and close', async () => {
    await mount(<Single />);
    await click(trigger());
    await type('deep v4');
    expect(rowKeys()).toEqual(['openrouter::deepseek/deepseek-v4-pro']);
    expect(search().getAttribute('aria-activedescendant')).toBe(rowEls()[0].id);
    await key('Enter');
    expect(picks).toEqual([{ route: 'openrouter', model: 'deepseek/deepseek-v4-pro' }]);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger().textContent).toContain('deepseek/deepseek-v4-pro');
  });

  it('compares the highlighted row with the current one', async () => {
    await mount(<Single />);
    await click(trigger());
    await type('gemini pro');
    const strip = document.querySelector('[data-testid="model-picker-compare"]')!;
    expect(strip.textContent).toContain('vs claude-sonnet-5');
    expect(strip.textContent).toContain('out $12 +20%');
    expect(strip.textContent).toContain('older');
  });

  it('Escape clears the search first, then closes', async () => {
    await mount(<Single />);
    await click(trigger());
    await type('qwen');
    await key('Escape');
    expect(search().value).toBe('');
    await key('Escape');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(picks).toEqual([]);
  });

  it('renders no native select or datalist and stays square', async () => {
    await mount(<Single />);
    await click(trigger());
    expect(document.querySelector('select, datalist')).toBeNull();
    const panel = document.querySelector('[data-testid="model-picker-panel"]')!;
    expect(panel.className).not.toMatch(/rounded/);
    expect(panel.className).toContain('shadow-md');
  });
});

describe('CatalogModelPicker, multi', () => {
  function Multi({ onChange }: { onChange: (v: unknown) => void }) {
    return (
      <CatalogModelPicker
        mode="multi"
        aria-label="Add models to standard"
        tier="standard"
        routes={[ARM_ROUTE_SPECS.anthropic, ARM_ROUTE_SPECS.openrouter]}
        models={MODELS}
        locked={[{ route: 'anthropic', model: 'claude-sonnet-5' }]}
        value={[]}
        max={3}
        currentLabel="in pool"
        onChange={onChange}
      />
    );
  }

  it('checks locked rows, keeps pick order as priority, caps at max, and confirms in order', async () => {
    let out: unknown = null;
    await mount(<Multi onChange={(v) => { out = v; }} />);
    await click(trigger());
    expect(document.querySelector('[role="listbox"]')!.getAttribute('aria-multiselectable')).toBe('true');
    const lockedRow = rowEls().find((r) => r.getAttribute('data-key') === 'anthropic::claude-sonnet-5')!;
    expect(lockedRow.getAttribute('aria-selected')).toBe('true');
    expect(lockedRow.getAttribute('aria-disabled')).toBe('true');
    expect(lockedRow.textContent).toContain('in pool');

    const byKey = (k: string) => rowEls().find((r) => r.getAttribute('data-key') === k)!;
    await click(byKey('openrouter::qwen/qwen3-next'));
    await click(byKey('openrouter::deepseek/deepseek-v4-pro'));
    expect(document.querySelector('[data-testid="model-picker-count"]')!.textContent).toBe('3/3');
    // Full: an unchecked row is disabled.
    expect(byKey('openrouter::google/gemini-3-pro').getAttribute('aria-disabled')).toBe('true');
    await click(byKey('openrouter::google/gemini-3-pro'));

    const draft = () => Array.from(document.querySelectorAll('[data-testid="model-picker-draft-item"]')).map((li) => li.textContent);
    expect(draft()[0]).toContain('qwen/qwen3-next');
    await click(document.querySelector('[aria-label="Move deepseek/deepseek-v4-pro up"]'));
    expect(draft()[0]).toContain('deepseek/deepseek-v4-pro');

    await click(document.querySelector('[data-testid="model-picker-confirm"]'));
    expect(out).toEqual([
      { route: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
      { route: 'openrouter', model: 'qwen/qwen3-next' },
    ]);
  });
});
