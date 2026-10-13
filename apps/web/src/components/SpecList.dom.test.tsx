/**
 * A workspace's spec list, mounted (happy-dom), living-specs.md §9 AC-21/22:
 * a child sits under its parent, each row says where it stands in words, and
 * an empty workspace says how specs get made with no count.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecList } = await import('./SpecList');
const { specTree } = await import('@/lib/specs/page-view');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const now = new Date();
const row = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, workspaceId: 'w', title, scope: 'feature', parentSpecId: null, status: 'draft', version: 1,
  bodyArtifactId: 'a', headRevision: 1, approvedRevision: null, createdBy: null, createdAt: now, updatedAt: now, ...over,
}) as any;

describe('SpecList', () => {
  it('nests a child under its parent and says where each spec stands', () => {
    const specs = specTree([
      row('p', 'Checkout', { approvedRevision: 1, headRevision: 2, scope: 'product' }),
      row('c', 'Totals', { parentSpecId: 'p', approvedRevision: 3, headRevision: 3, status: 'approved' }),
      row('d', 'Refunds'),
    ]);
    act(() => root.render(<SpecList specs={specs} />));
    const top = [...container.querySelectorAll('[data-testid="spec-list"] > li')].map((li) => li.getAttribute('data-spec-id'));
    expect(top).toEqual(['p', 'd']);
    const parent = container.querySelector('[data-spec-id="p"]')!;
    expect(parent.querySelector('[data-testid="spec-list-children"] [data-spec-id="c"]')).not.toBeNull();
    expect(parent.querySelector('a')!.getAttribute('href')).toBe('/app/specs/p');
    expect(container.textContent).toContain('product · approved at revision 1');
    expect(parent.querySelector('[data-testid="spec-list-waiting"]')!.textContent).toBe('Revision 2 waiting for approval');
    expect(container.querySelector('[data-spec-id="c"] [data-testid="spec-list-waiting"]')).toBeNull();
    expect(container.querySelector('[data-spec-id="d"]')!.textContent).toContain('draft, never approved');
  });

  it('an empty workspace says how specs get made and shows no count', () => {
    act(() => root.render(<SpecList specs={[]} />));
    const text = container.textContent ?? '';
    expect(container.querySelector('[data-testid="spec-list-empty"]')).not.toBeNull();
    expect(text).toContain('MCP');
    expect(text).toContain('chat');
    expect(text).not.toMatch(/\d/);
  });
});
