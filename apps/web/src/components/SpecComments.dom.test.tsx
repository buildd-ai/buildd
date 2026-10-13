/**
 * Comments on a spec revision, mounted (happy-dom), living-specs.md §16:
 * threads group under their criterion or section with a state chip; adding
 * posts the anchor and revision; a person may resolve; a reader with no
 * write access sees no add action.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let refreshes = 0;
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => { refreshes++; } }),
  usePathname: () => '/app/specs/x',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecComments } = await import('./SpecComments');

const SPEC = '11111111-1111-4111-8111-111111111111';
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); refreshes = 0; });
afterEach(() => { act(() => root.unmount()); container.remove(); globalThis.fetch = realFetch; });

const comment = (id: string, over: Record<string, unknown> = {}) => ({
  id, anchor: { kind: 'criterion', id: 'AC-2', label: 'AC-2' }, anchorHere: 'AC-2', body: `text ${id}`, author: { kind: 'agent', id: 'a' },
  madeOnRevision: 2, parentCommentId: null, state: 'open', resolvedBy: null, createdAt: new Date().toISOString(), ...over,
}) as any;
const anchors = [{ kind: 'criterion' as const, id: 'AC-2', label: 'AC-2' }, { kind: 'section' as const, id: 's2', label: 'Scope' }];
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('SpecComments', () => {
  it('groups threads by anchor, with a state chip, replies indented', () => {
    act(() => root.render(<SpecComments specId={SPEC} revision={3} anchors={anchors} canComment canResolve comments={[
      comment('c1'), comment('c2', { parentCommentId: 'c1', author: { kind: 'user', id: 'u' } }),
      comment('c3', { anchor: { kind: 'section', id: 's2', label: 'Scope' }, state: 'outdated' }),
    ]} />));
    const threads = [...container.querySelectorAll('[data-testid="spec-comment-thread"]')];
    expect(threads.map((t) => t.querySelector('p')!.textContent)).toEqual(['AC-2', 'Section "Scope"']);
    const items = [...container.querySelectorAll('[data-testid="spec-comment"]')];
    expect(items.map((i) => i.getAttribute('data-state'))).toEqual(['open', 'open', 'outdated']);
    expect(items[0]!.textContent).toContain('An agent on revision 2');
    expect(items[0]!.textContent).toContain('Open');
    expect(items[2]!.textContent).toContain('Outdated');
    // Resolve on a thread head only, and not on a resolved one.
    expect(container.querySelectorAll('[data-testid="spec-comment-resolve"]').length).toBe(2);
  });

  it('adding posts the anchor and the revision being read, then refreshes', async () => {
    const calls: Array<[string, any]> = [];
    globalThis.fetch = (async (url: string, init: any) => { calls.push([url, JSON.parse(init.body)]); return new Response('{}', { status: 201 }); }) as any;
    act(() => root.render(<SpecComments specId={SPEC} revision={3} anchors={anchors} canComment canResolve={false} comments={[]} />));
    expect(container.textContent).toContain('No comments on revision 3.');
    act(() => { q('spec-comment-add')!.click(); });
    const ta = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => { setter.call(ta, 'Which currency?'); ta.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { q('spec-comment-save')!.click(); });
    expect(calls).toEqual([[`/api/specs/${SPEC}/comments`, { revision: 3, body: 'Which currency?', anchor: { criterion: 'AC-2' } }]]);
    expect(refreshes).toBe(1);
  });

  it('a reader who cannot write sees no add action and no resolve', () => {
    act(() => root.render(<SpecComments specId={SPEC} revision={1} anchors={anchors} canComment={false} canResolve={false} comments={[comment('c1')]} />));
    expect(q('spec-comment-add')).toBeNull();
    expect(q('spec-comment-resolve')).toBeNull();
  });
});
