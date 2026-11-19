/**
 * Platform defaults (operator section of Settings › Models › Tiers): shows the
 * server's read model, asks before every write, sends confirm flags the server
 * demands, and shows the server's words when it refuses.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: PlatformTierDefaultsSection } = await import('./PlatformTierDefaultsSection');
const { formControls } = await import('../_lib/form-controls');
const { MODEL_TIERS_CHANGED_EVENT } = await import('./CellEditor');

const facts = (price: [number, number], floor: string | null, certification = 'baseline') => ({
  model: 'x', catalogId: 'x', inCatalog: true, price: { input: price[0], output: price[1] }, floor, certification,
  certified: certification === 'baseline' || certification === 'certified', releasedAt: null, deprecated: null, retired: false,
});

let view: Record<string, unknown>;
let puts: Array<Record<string, unknown>>;
let putResponses: Array<{ status: number; body: unknown }>;
let reads: number;
let changedEvents = 0;
// One listener for the whole file: a per-test listener would stack and count each event many times.
window.addEventListener(MODEL_TIERS_CHANGED_EVENT, () => { changedEvents++; });

beforeEach(() => {
  reads = 0; puts = []; changedEvents = 0;
  putResponses = [{ status: 200, body: { ok: true, after: { model: 'claude-fable-5-2' } } }];
  view = {
    catalogChecked: true,
    canWrite: true,
    tiers: [
      {
        tier: 'premium-plus', band: { minInput: 8, maxInput: 20 },
        effective: { provider: 'anthropic', model: 'claude-fable-5-1', source: 'platform', facts: facts([10, 50], '2.1.251') },
        platform: { tier: 'premium-plus', provider: 'anthropic', model: 'claude-fable-5-1', setAt: '2026-11-14T10:00:00.000Z', setBy: { accountId: null, userId: 'op', via: 'mcp' }, reason: 'hold', previous: { model: 'claude-fable-5' } },
        suggestion: { tier: 'premium-plus', kind: 'newer', model: 'claude-fable-5-1', newer: 'claude-fable-5-2', facts: facts([8, 40], '2.1.321'), applicable: true, needsBandConfirm: false, why: 'A newer model exists for this tier: claude-fable-5-2 ($8 in / $40 out per MTok, Claude Code 2.1.321 or newer).' },
        canRevert: true,
      },
      {
        tier: 'premium', band: { minInput: 4, maxInput: 8 },
        effective: { provider: 'anthropic', model: 'claude-opus-5-5', source: 'catalog', facts: facts([4, 20], '2.1.280') },
        platform: null, suggestion: null, canRevert: false,
      },
    ],
  };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/model-tiers/platform') && (!init || !init.method || init.method === 'GET')) {
      reads++;
      return Response.json(view);
    }
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)));
      const r = putResponses.length > 1 ? putResponses.shift()! : putResponses[0];
      return Response.json(r.body, { status: r.status });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<PlatformTierDefaultsSection />); });
  await flush(); await flush();
}
const q = (sel: string, within: ParentNode = host) => within.querySelector(sel) as HTMLElement | null;
const tierRow = (tier: string) => q(`[data-testid="platform-tier-${tier}"]`)!;
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); await flush(); };

describe('PlatformTierDefaultsSection', () => {
  it('renders each tier with its model, source, price and floor, the stored row and the suggestion', async () => {
    await mount();
    expect(reads).toBe(1);
    const pp = tierRow('premium-plus');
    expect(q('[data-testid="platform-tier-model"]', pp)!.textContent).toBe('claude-fable-5-1');
    expect(q('[data-testid="platform-tier-source"]', pp)!.textContent).toContain('platform default');
    expect(q('[data-testid="platform-tier-facts"]', pp)!.textContent).toBe('$10 in / $50 out per MTok · Claude Code 2.1.251+ · certified (built-in table)');
    expect(q('[data-testid="platform-tier-row"]', pp)!.textContent).toContain('via mcp: hold');
    expect(q('[data-testid="platform-tier-row"]', pp)!.textContent).toContain('Revert restores');
    expect(q('[data-testid="platform-tier-suggestion"]', pp)!.textContent).toContain('A newer model exists for this tier: claude-fable-5-2');
    const premium = tierRow('premium');
    expect(q('[data-testid="platform-tier-source"]', premium)!.textContent).toContain('catalog pick');
    expect(q('[data-testid="platform-tier-suggestion"]', premium)).toBeNull();
    expect(q('[data-testid="platform-tier-clear"]', premium)).toBeNull();
    expect(q('[data-testid="platform-tier-revert"]', premium)).toBeNull();
    expect(host.textContent).not.toContain('—');
  });

  it('a non-operator view has no controls at all', async () => {
    view.canWrite = false;
    await mount();
    expect(formControls(host)).toEqual([]);
    expect(q('[data-testid="platform-tier-suggestion"]')!.textContent).not.toContain('Apply');
  });

  it('Apply asks first, then sends the suggestion with confirm, reloads and tells the tier table', async () => {
    await mount();
    const pp = tierRow('premium-plus');
    await click([...pp.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Apply'))!);
    expect(puts).toEqual([]);
    expect(q('[data-testid="platform-tier-confirm"]', pp)!.textContent).toContain('Move Premium-plus to the suggested model');
    await click(q('[data-testid="platform-tier-confirm-yes"]', pp));
    expect(puts).toEqual([{ op: 'apply', tier: 'premium-plus', confirm: true, confirmBandChange: false, via: 'ui' }]);
    expect(reads).toBe(2);
    expect(changedEvents).toBe(1);
    expect(q('[data-testid="platform-tier-message"]')!.textContent).toContain('Premium-plus now runs');
  });

  it('Set sends the typed model; a band refusal asks once more and resends with the band confirm', async () => {
    putResponses = [
      { status: 409, body: { error: 'claude-opus-5-5 is priced at $4 input per MTok, below the premium-plus band ($8 to $20).', code: 'spend_band_change' } },
      { status: 200, body: { ok: true, after: { model: 'claude-opus-5-5' } } },
    ];
    await mount();
    const pp = tierRow('premium-plus');
    const input = q('[data-testid="platform-tier-input"]', pp) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'claude-opus-5-5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await click(q('[data-testid="platform-tier-set"]', pp));
    expect(q('[data-testid="platform-tier-confirm"]', pp)!.textContent).toContain('Set Premium-plus to claude-opus-5-5');
    await click(q('[data-testid="platform-tier-confirm-yes"]', pp));
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ op: 'set', model: 'claude-opus-5-5', confirm: true, confirmBandChange: false });
    // The server's words, then a second ask for the spend change.
    const again = q('[data-testid="platform-tier-confirm"]', pp)!;
    expect(again.textContent).toContain('below the premium-plus band');
    expect(q('[data-testid="platform-tier-confirm-yes"]', pp)!.textContent).toBe('Accept and apply');
    await click(q('[data-testid="platform-tier-confirm-yes"]', pp));
    expect(puts[1]).toMatchObject({ op: 'set', model: 'claude-opus-5-5', confirm: true, confirmBandChange: true });
    expect(q('[data-testid="platform-tier-message"]')!.textContent).toContain('Opus 5.5');
  });

  it('Revert and Clear ask first; Cancel sends nothing; a refusal shows the server message', async () => {
    putResponses = [{ status: 403, body: { error: 'buildd manages this setting.', code: 'operator_only' } }];
    await mount();
    const pp = tierRow('premium-plus');
    await click(q('[data-testid="platform-tier-revert"]', pp));
    expect(q('[data-testid="platform-tier-confirm"]', pp)!.textContent).toContain('Revert the last Premium-plus change?');
    await click(q('[data-testid="platform-tier-confirm-no"]', pp));
    expect(puts).toEqual([]);
    expect(q('[data-testid="platform-tier-confirm"]', pp)).toBeNull();
    await click(q('[data-testid="platform-tier-clear"]', pp));
    expect(q('[data-testid="platform-tier-confirm"]', pp)!.textContent).toContain('Remove the Premium-plus platform default?');
    await click(q('[data-testid="platform-tier-confirm-yes"]', pp));
    expect(puts).toEqual([{ op: 'clear', tier: 'premium-plus', confirm: true, confirmBandChange: false, via: 'ui' }]);
    const alert = q('[data-testid="platform-tier-message"]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('buildd manages this setting.');
    expect(changedEvents).toBe(0);
  });

  it('says so when the catalog could not be read', async () => {
    view.catalogChecked = false;
    await mount();
    expect(q('[data-testid="platform-tier-catalog-warning"]')).not.toBeNull();
  });
});
