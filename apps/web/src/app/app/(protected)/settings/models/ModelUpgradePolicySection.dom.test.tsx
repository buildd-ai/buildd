/**
 * The upgrade-policy section explains what each tier is pinned to and why, so
 * it must revalidate when a tier is edited in the table above, not on reload.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ModelUpgradePolicySection } = await import('./ModelUpgradePolicySection');
const { MODEL_TIERS_CHANGED_EVENT } = await import('./CellEditor');

let policyReads = 0;
beforeEach(() => {
  policyReads = 0;
  globalThis.fetch = mock(async (url: string) => {
    if (String(url).startsWith('/api/model-tiers/policy')) {
      policyReads++;
      return new Response(JSON.stringify({ policy: { mode: 'manual' }, source: 'default', tiers: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe('ModelUpgradePolicySection', () => {
  it('refetches when a tier is saved above, and stops listening on unmount', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(<ModelUpgradePolicySection teamId="team-demo" isAdmin />); });
    await flush();
    expect(policyReads).toBe(1);

    await act(async () => { window.dispatchEvent(new CustomEvent(MODEL_TIERS_CHANGED_EVENT)); });
    await flush();
    expect(policyReads).toBe(2);

    act(() => root.unmount());
    window.dispatchEvent(new CustomEvent(MODEL_TIERS_CHANGED_EVENT));
    await flush();
    expect(policyReads).toBe(2);
    root = createRoot(host); // afterEach unmounts it again
  });
});

describe('ModelUpgradePolicySection: one row, no second tier list', () => {
  it('renders the policy select, not a per-tier list (the tier table carries that)', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(<ModelUpgradePolicySection teamId="team-demo" isAdmin />); });
    await flush();
    expect(host.querySelector('[data-testid="model-upgrade-mode"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="model-upgrade-tiers"]')).toBeNull();
    expect(host.querySelector('.card')).toBeNull();
  });
});

describe('upgradeNote', () => {
  const base = { tier: 'standard', model: 'claude-model-a', selectedBy: 'catalog', why: 'Catalog default.', newer: null, withheld: null, deprecated: null } as const;
  it('says nothing when the tier is current', async () => {
    const { upgradeNote } = await import('./ModelUpgradePolicySection');
    expect(upgradeNote({ ...base } as never)).toBeNull();
  });
  it('names a newer model and why it is withheld', async () => {
    const { upgradeNote } = await import('./ModelUpgradePolicySection');
    const note = upgradeNote({ ...base, newer: { model: 'claude-model-b', certifiedAt: null }, withheld: { reason: 'manual', eligibleAt: null } } as never);
    expect(note).toContain('is available.');
    expect(note).toContain('Your upgrade policy is manual.');
  });
});
