/**
 * The spec page's Files (living-specs.md §21, AC-104, AC-105): each
 * attachment's name, kind, caption, who and which revision; a binding one
 * that changed since approval says so, a reference one never does; attaching
 * and removing show only on the head for a reader who can write.
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
const { default: SpecAttachments, approvalLine, suggestedName } = await import('./SpecAttachments');

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

const row = (o: Record<string, unknown>) => ({
  id: String(o.name), name: 'pay-screen', kind: 'binding', caption: null, artifactId: 'a', title: null, mimeType: 'image/png', isImage: true,
  artifactRevision: 3, addedInRevision: 1, removedFromRevision: null, addedBy: { kind: 'person', name: 'Sam' }, addedAt: '2026-10-10T00:00:00.000Z', addedAgo: '3d ago',
  url: '/api/specs/s/attachments/pay-screen?revision=2', approval: null, ...o,
}) as any;

describe('Files', () => {
  it('lists each attachment with kind, caption, who and revision; flags only a changed binding one', () => {
    act(() => root.render(<SpecAttachments specId="s" revision={2} isHead canAttach attachments={[
      row({ name: 'pay-screen', caption: 'The pay screen', approval: { state: 'changed', pinned: 2, current: 3 } }),
      row({ name: 'notes', kind: 'reference', isImage: false, addedBy: { kind: 'agent', name: null }, addedInRevision: 2 }),
    ]} />));
    const items = [...container.querySelectorAll('[data-testid="spec-attachment"]')];
    expect(items.map((i) => i.getAttribute('data-name'))).toEqual(['pay-screen', 'notes']);
    expect(items[0]!.textContent).toContain('Binding');
    expect(items[0]!.textContent).toContain('The pay screen');
    expect(items[0]!.textContent).toContain('Added by Sam in revision 1');
    expect(items[0]!.querySelector('[data-testid="spec-attachment-changed"]')?.textContent).toContain('Changed since approval');
    expect(items[1]!.textContent).toContain('Reference');
    expect(items[1]!.textContent).toContain('Added by an agent in revision 2');
    expect(items[1]!.querySelector('[data-testid="spec-attachment-changed"]')).toBeNull();
    expect(container.querySelector('[data-testid="spec-attach-add"]')).not.toBeNull();
  });

  it('an older revision, or a reader who cannot write, gets no attach or remove', () => {
    act(() => root.render(<SpecAttachments specId="s" revision={1} isHead={false} canAttach attachments={[row({ name: 'pay-screen' })]} />));
    expect(container.querySelector('[data-testid="spec-attach-add"]')).toBeNull();
    expect(container.querySelector('[data-testid="spec-attachment-remove"]')).toBeNull();
  });

  it('says how a binding attachment stands, and suggests a name from a file name', () => {
    expect(approvalLine({ approval: null })).toBeNull();
    expect(approvalLine({ approval: { state: 'unchanged', pinned: 1, current: 1 } })).toBeNull();
    expect(approvalLine({ approval: { state: 'added', pinned: null, current: 1 } })).toBe('Added since approval.');
    expect(approvalLine({ approval: { state: 'changed', pinned: 1, current: 2 } })).toBe('Changed since approval: it is at version 2, approved at version 1.');
    expect(suggestedName('Pay Screen (v2).PNG')).toBe('pay-screen-v2');
  });
});
