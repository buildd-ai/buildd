/**
 * Retiring on the spec page (living-specs.md §22, R-54, AC-111): a retired spec
 * reads "Retired: <reason>" or "Replaced by <spec>" with Restore for a person
 * who may; a live one offers that person Retire with a reason, which posts to
 * the retire route; a reader without the right sees neither control.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecRetire } = await import('./SpecRetire');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const calls: Array<{ url: string; method: string; body: unknown }> = [];
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls.length = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ spec: { id: 's' } }), { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const retired = (o: Record<string, unknown> = {}) => ({ status: 'retired', reason: 'A duplicate import of checkout', supersededBy: null, by: 'user:u', at: '2026-10-14T00:00:00.000Z', ...o }) as any;
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('SpecRetire', () => {
  it('a retired spec says why, and Restore sends DELETE', async () => {
    act(() => root.render(<SpecRetire specId="s" retirement={retired()} canRetire />));
    expect(q('spec-retired-line')?.textContent).toBe('Retired: A duplicate import of checkout');
    await act(async () => { (q('spec-restore') as HTMLButtonElement).click(); });
    expect(calls).toEqual([{ url: '/api/specs/s/retire', method: 'DELETE', body: {} }]);
  });

  it('a superseded spec links its replacement; a reader without the right gets no Restore', () => {
    act(() => root.render(<SpecRetire specId="s" retirement={retired({ status: 'superseded', supersededBy: { id: 'n', title: 'Checkout v2' } })} canRetire={false} />));
    expect(q('spec-retired-line')?.textContent).toContain('Replaced by Checkout v2');
    expect(q('spec-retired-line')?.querySelector('a')?.getAttribute('href')).toBe('/app/specs/n');
    expect(q('spec-restore')).toBeNull();
  });

  it('a live spec offers Retire folded away; it needs a 10-character reason and posts it', async () => {
    act(() => root.render(<SpecRetire specId="s" retirement={null} canRetire targets={[{ id: 'n', title: 'Checkout v2' }]} />));
    expect(q('spec-retire-form')).toBeNull();
    act(() => { (q('spec-retire')!.querySelector('button') as HTMLButtonElement).click(); });
    const submit = q('spec-retire-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const box = q('spec-retire-reason') as HTMLTextAreaElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'A duplicate import of checkout');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
    expect(calls).toEqual([{ url: '/api/specs/s/retire', method: 'POST', body: { reason: 'A duplicate import of checkout' } }]);
  });

  it('a reader without the right sees nothing on a live spec', () => {
    act(() => root.render(<SpecRetire specId="s" retirement={null} canRetire={false} />));
    expect(container.innerHTML).toBe('');
  });
});
