/**
 * VisualReviewDeck, mounted (happy-dom): the review queue. Two buttons whose
 * effect follows the agent's verdict, keys, apply-to-both, the needs-fix
 * note, the undo toast, accept-remaining at the end of the queue, compare,
 * and the optimistic hook's rollback on a 409 stale and on a failure.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 * Illustrative fixtures only.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { VisualReviewModel } from '@buildd/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { buildVisualReviewFixtureModel } = await import('@/lib/visual-review-model.fixtures');
const { default: VisualReviewDeck, swipeStep, verdictEffects } = await import('./VisualReviewDeck');
const { useVisualReviewDecisions, VisualReviewRequestError } = await import('./review-transport');
const { createFixtureVisualReviewTransport } = await import('./fixture-transport');
type Transport = import('./review-transport').VisualReviewTransport;
type DecideInput = import('./review-transport').DecideInput;
type DecideResult = import('./review-transport').DecideResult;

const deckModel = (): VisualReviewModel => buildVisualReviewFixtureModel('needs_you', { scenario: 'deck' });

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

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const key = (k: string) => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const route = () => q('deck-route')!.textContent;
const focused = () => q('visual-review-deck')!.dataset.focused;
const typeInto = (input: HTMLInputElement, value: string) => act(() => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

function okDecide() {
  let n = 0;
  return mock(async (input: DecideInput): Promise<DecideResult> => ({
    ok: true,
    reviewIds: input.cells.map(() => `r${++n}`),
    fixTaskId: null,
    cancelledFixTaskId: null,
    guidanceTaskId: null,
  }));
}

function renderDeck(props: Partial<React.ComponentProps<typeof VisualReviewDeck>> = {}) {
  const onDecide = props.onDecide ?? okDecide();
  const onUndo = props.onUndo ?? mock(async (_ids: readonly string[]) => ({ ok: true as const }));
  act(() => root.render(
    <VisualReviewDeck model={deckModel()} layout="sheet" onDecide={onDecide} onUndo={onUndo} {...props} />,
  ));
  return { onDecide: onDecide as ReturnType<typeof okDecide>, onUndo: onUndo as ReturnType<typeof mock> };
}

function Connected({ transport, model }: { transport: Transport; model: VisualReviewModel }) {
  const d = useVisualReviewDecisions(model, transport);
  return <VisualReviewDeck model={d.model} layout="sheet" onDecide={d.decide} onUndo={d.undo} />;
}

describe('verdict-aware buttons', () => {
  it('two buttons whatever the agent said; the effect follows the verdict', () => {
    expect(verdictEffects('ok')).toEqual({ looks_right: 'agree', needs_fix: 'dispute' });
    expect(verdictEffects('issue')).toEqual({ looks_right: 'dispute', needs_fix: 'agree' });
    expect(verdictEffects('unsure')).toEqual({ looks_right: 'waive', needs_fix: 'dispute' });
  });

  it('opens at the head of the queue (the unsure screen) with its finding and progress', () => {
    const m = deckModel();
    renderDeck();
    expect(route()).toBe('/app/missions/:id');
    expect(focused()).toBe('/app/missions/:id|mobile|');
    expect(q('deck-progress')!.textContent).toBe(`${m.summary.reviewed} of ${m.cells.length} reviewed`);
    expect(q('visual-review-deck')!.textContent).toContain('The empty state shows two headings');
    expect(q('deck-looks-right')!.textContent).toContain('Looks right');
    expect(q('deck-needs-fix')!.textContent).toContain('Needs fix');
    expect(q('deck-looks-right')!.dataset.effect).toBe('waive');
    expect(q('deck-needs-fix')!.dataset.effect).toBe('dispute');
    expect(q('deck-needs-fix')!.textContent).toContain('File a fix');
  });

  it('an issue shows its fix task with status and PR, and Looks right would drop the fix', () => {
    renderDeck({ startKey: '/app/settings|desktop|' });
    expect(focused()).toBe('/app/settings|desktop|');
    expect(q('deck-looks-right')!.dataset.effect).toBe('dispute');
    expect(q('deck-needs-fix')!.dataset.effect).toBe('agree');
    const fix = qa('deck-fix').find(f => f.closest('[data-viewport="desktop"]'))!;
    expect(fix.textContent).toContain('The save bar covers the last settings row');
    expect(fix.textContent).toContain('PR #2');
    expect(fix.textContent?.toLowerCase()).toContain('in progress');
  });
});

describe('deciding', () => {
  it('Y decides the focused screen only when the viewports disagree, then moves on', async () => {
    const { onDecide } = renderDeck();
    expect((q('deck-apply-both') as HTMLInputElement).checked).toBe(false);
    key('y');
    await flush();
    expect(onDecide).toHaveBeenCalledTimes(1);
    const input = onDecide.mock.calls[0][0];
    expect(input.decision).toBe('looks_right');
    expect(input.cells.map(c => c.key)).toEqual(['/app/missions/:id|mobile|']);
    // The desktop screen of the same route is next.
    expect(focused()).toBe('/app/missions/:id|desktop|');
    expect(q('deck-toast')).not.toBeNull();
  });

  it('applies to both viewports by default when their verdicts match', async () => {
    const { onDecide } = renderDeck({ startKey: '/app/tasks/:id|desktop|' });
    expect((q('deck-apply-both') as HTMLInputElement).checked).toBe(true);
    act(() => q('deck-looks-right')!.click());
    await flush();
    expect(onDecide.mock.calls[0][0].cells.map(c => c.key).sort()).toEqual(['/app/tasks/:id|desktop|', '/app/tasks/:id|mobile|']);
    expect(route()).not.toBe('/app/tasks/:id');
  });

  it('Needs fix opens the one-line note prefilled with the finding; Enter files it', async () => {
    const { onDecide } = renderDeck();
    key('n');
    const note = q('deck-note') as HTMLInputElement;
    expect(note).not.toBeNull();
    expect(note.value).toBe('The empty state shows two headings; it may be intended.');
    // Keys typed into the note are not shortcuts.
    act(() => { note.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); });
    expect(focused()).toBe('/app/missions/:id|mobile|');
    typeInto(note, 'Drop the second heading.');
    act(() => { note.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(onDecide.mock.calls[0][0]).toMatchObject({ decision: 'needs_fix', note: 'Drop the second heading.' });
  });

  it('Needs fix on an issue leaves the note empty (it only adds guidance)', () => {
    renderDeck({ startKey: '/app/settings|desktop|' });
    act(() => q('deck-needs-fix')!.click());
    expect((q('deck-note') as HTMLInputElement).value).toBe('');
    act(() => q('deck-note-cancel')!.click());
    expect(q('deck-note')).toBeNull();
  });

  it('shows a 5 second undo; the button and U undo the decision just made', async () => {
    const { onUndo } = renderDeck({ undoMs: 120 });
    key('y');
    await flush();
    expect(q('deck-toast')!.textContent).toContain('Undo');
    act(() => q('deck-undo')!.click());
    await flush();
    expect(onUndo).toHaveBeenCalledWith(['r1']);
    // Back on the undone screen.
    expect(focused()).toBe('/app/missions/:id|mobile|');

    key('y');
    await flush();
    key('u');
    await flush();
    expect(onUndo).toHaveBeenCalledTimes(2);

    key('y');
    await flush();
    await wait(200);
    expect(q('deck-toast')).toBeNull();
    expect(VisualReviewDeck).toBeDefined();
  });

  it('the default undo window is five seconds', () => {
    renderDeck();
    expect(q('visual-review-deck')!.dataset.undoMs).toBe('5000');
  });

  it('J and K walk the routes; the end offers to accept every screen the agent marked fine', async () => {
    const m = deckModel();
    const { onDecide } = renderDeck();
    const routes = new Set<string>();
    for (let i = 0; i < 10 && !q('deck-end'); i++) { routes.add(route()!); key('j'); }
    expect(q('deck-end')).not.toBeNull();
    expect(routes.size).toBe(new Set(m.cells.map(c => c.route)).size);
    const okLeft = m.cells.filter(c => !c.current.review && c.current.agentVerdict === 'ok');
    const accept = q('deck-accept-all')!;
    expect(accept.textContent).toBe(`Accept all ${okLeft.length} the agent marked fine`);
    act(() => accept.click());
    await flush();
    const input = onDecide.mock.calls[0][0];
    expect(input.decision).toBe('looks_right');
    expect(input.cells.map(c => c.key).sort()).toEqual(okLeft.map(c => c.key).sort());
    key('k');
    expect(q('deck-end')).toBeNull();
  });

  it('C opens compare on a screen shot in two rounds, and swipe is off while comparing', () => {
    renderDeck({ startKey: '/app/tasks/:id|mobile|' });
    expect(q('visual-review-compare')).toBeNull();
    key('c');
    expect(q('visual-review-compare')).not.toBeNull();
    expect(q('compare-fix')!.textContent).toContain('Header title overflows');
    expect(q('compare-fix')!.textContent).toContain('PR #1');
    expect(q('visual-review-deck')!.dataset.swipe).toBe('off');
    key('c');
    expect(q('visual-review-compare')).toBeNull();
    expect(q('visual-review-deck')!.dataset.swipe).toBe('on');
  });
});

describe('layout', () => {
  it('sheet renders inline with no dialog; dialog uses the shared Dialog', () => {
    renderDeck();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(q('visual-review-deck')!.dataset.layout).toBe('sheet');
    act(() => root.render(<VisualReviewDeck model={deckModel()} layout="dialog" open onClose={() => {}} onDecide={okDecide()} onUndo={async () => ({ ok: true })} />));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('the phone bar is sticky in the safe area with two half-width buttons at least 48px tall', () => {
    renderDeck();
    const bar = q('deck-actions')!;
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('bottom-0');
    expect(bar.className).toContain('safe-area-inset-bottom');
    for (const id of ['deck-looks-right', 'deck-needs-fix']) {
      expect(q(id)!.className).toContain('min-h-12');
      expect(q(id)!.className).toContain('basis-1/2');
    }
  });

  it('the phone image is width-fit with no height cap', () => {
    renderDeck();
    const img = document.querySelector<HTMLElement>('[data-focused-shot="true"] [data-testid="visual-review-img"]')!;
    expect(img.className).toContain('w-full');
    expect(img.className).not.toMatch(/(^|\s)max-h-/);
  });

  it('swipe: horizontal only, 40px threshold, off while zoomed or comparing', () => {
    expect(swipeStep({ dx: -41, dy: 5 })).toBe(1);
    expect(swipeStep({ dx: 41, dy: 5 })).toBe(-1);
    expect(swipeStep({ dx: -39, dy: 0 })).toBe(0);
    expect(swipeStep({ dx: -60, dy: 70 })).toBe(0);
    expect(swipeStep({ dx: -60, dy: 5, zoomed: true })).toBe(0);
    expect(swipeStep({ dx: -60, dy: 5, comparing: true })).toBe(0);
  });
});

describe('optimistic apply with rollback', () => {
  it('a 409 stale re-renders the returned cell and is not retried', async () => {
    const t = createFixtureVisualReviewTransport('needs_you', { needsYou: 'unsure', scenario: 'deck' }, { staleOnce: true });
    const decide = mock(t.decide);
    const transport: Transport = { decide, undo: t.undo };
    act(() => root.render(<Connected transport={transport} model={t.model()} />));
    key('y');
    await flush();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(q('deck-notice')!.textContent).toContain('changed while you looked');
    expect(focused()).toBe('/app/missions/:id|mobile|');
    expect(q('deck-progress')!.textContent).toBe(`1 of ${t.model().cells.length} reviewed`);
    await flush();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('applies at once, then rolls back when the server fails', async () => {
    let reject!: (e: unknown) => void;
    const transport: Transport = {
      decide: () => new Promise((_, r) => { reject = r; }),
      undo: async () => { throw new Error('unused'); },
    };
    const m = deckModel();
    act(() => root.render(<Connected transport={transport} model={m} />));
    key('y');
    await flush();
    expect(q('deck-progress')!.textContent).toBe(`${m.summary.reviewed + 1} of ${m.cells.length} reviewed`);
    await act(async () => { reject(new VisualReviewRequestError(500, { error: 'boom' })); });
    await flush();
    expect(q('deck-progress')!.textContent).toBe(`${m.summary.reviewed} of ${m.cells.length} reviewed`);
    expect(q('deck-notice')!.textContent).toContain('boom');
    expect(focused()).toBe('/app/missions/:id|mobile|');
  });

  it('end to end on the fixture transport: decide, see it land, undo it', async () => {
    const t = createFixtureVisualReviewTransport('needs_you', { needsYou: 'unsure', scenario: 'deck' });
    const m = t.model();
    act(() => root.render(<Connected transport={t} model={m} />));
    key('n');
    act(() => { (q('deck-note') as HTMLInputElement).form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(q('deck-progress')!.textContent).toBe(`${m.summary.reviewed + 1} of ${m.cells.length} reviewed`);
    expect(t.model().fixTasks.some(f => f.status === 'pending' && f.title.startsWith('[surface fix] /app/missions/:id:'))).toBe(true);
    act(() => q('deck-undo')!.click());
    await flush();
    expect(q('deck-progress')!.textContent).toBe(`${m.summary.reviewed} of ${m.cells.length} reviewed`);
    expect(t.model().fixTasks.filter(f => f.title.startsWith('[surface fix] /app/missions/:id:')).every(f => f.status === 'cancelled')).toBe(true);
  });
});
