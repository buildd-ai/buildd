/**
 * VisualReviewDeck, mounted (happy-dom): the review queue. Only screens
 * awaiting a decision are walked; the rest sit read-only at the end. Two
 * buttons whose effect follows the agent's verdict, keys, apply-to-both, the
 * needs-fix note, the undo toast with the server's outcome, compare, and the
 * optimistic hook's rollback on a 409 stale and on a failure.
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
const { buildVisualReviewFixtureModel, visualReviewFixtureInput, withFixtureImages } = await import('@/lib/visual-review-model.fixtures');
const { buildVisualReviewModel } = await import('@/lib/visual-review-model');
const { default: VisualReviewDeck, swipeStep, verdictEffects, OUTCOME_COPY } = await import('./VisualReviewDeck');
const { useVisualReviewDecisions, VisualReviewRequestError, applyOptimisticDecision, buildDecisionRequest } = await import('./review-transport');
const { createFixtureVisualReviewTransport } = await import('./fixture-transport');
type Transport = import('./review-transport').VisualReviewTransport;
type DecideInput = import('./review-transport').DecideInput;
type DecideResult = import('./review-transport').DecideResult;

const deckModel = (): VisualReviewModel => buildVisualReviewFixtureModel('needs_you', { scenario: 'deck' });
/** Screens the deck counts: only those awaiting a decision (the server's standing). */
const toReview = (m: VisualReviewModel) => m.cells.filter(c => c.standing === 'to_review').length;
/** The deck model with every screen of `route` made an undecided unsure, so both viewports are in the queue. */
const bothUnsure = (route: string): VisualReviewModel => {
  const m = deckModel();
  const cells = m.cells.map(c => (c.route === route
    ? { ...c, fixCheck: null, needsHuman: true, standing: 'to_review' as const, current: { ...c.current, agentVerdict: 'unsure' as const, review: null, fixTask: null } }
    : c));
  return { ...m, cells, queue: [...m.queue, ...cells.filter(c => c.route === route && !m.queue.includes(c.key)).map(c => c.key)] };
};

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
    outcome: null,
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
    expect(q('deck-progress')!.textContent).toBe(`${toReview(m)} to review`);
    expect(toReview(m)).toBe(2);
    expect(q('visual-review-deck')!.textContent).toContain('The empty state shows two headings');
    expect(q('deck-looks-right')!.textContent).toContain('Looks right');
    expect(q('deck-needs-fix')!.textContent).toContain('Needs fix');
    expect(q('deck-looks-right')!.dataset.effect).toBe('waive');
    expect(q('deck-needs-fix')!.dataset.effect).toBe('dispute');
    expect(q('deck-needs-fix')!.textContent).toContain('File fix');
    expect(q('deck-looks-right')!.textContent).toContain('Record only');
  });

  it('an issue shows its fix task with status and PR, and Looks right would drop the fix', () => {
    renderDeck({ startKey: '/app/settings|desktop|' });
    expect(focused()).toBe('/app/settings|desktop|');
    expect(q('deck-looks-right')!.dataset.effect).toBe('dispute');
    expect(q('deck-needs-fix')!.dataset.effect).toBe('agree');
    const fix = qa('deck-fix').find(f => f.closest('[data-viewport="desktop"]'))!;
    expect(fix.textContent).toContain('The save bar covers the last settings row');
    expect(fix.textContent).toContain('PR #2');
    expect(fix.textContent?.toLowerCase()).toContain('pr open, not merged');
  });
});

describe('deciding', () => {
  it('Y decides the focused screen, then moves on to the next screen awaiting a decision', async () => {
    const { onDecide } = renderDeck();
    // The desktop is fine by the agent: nothing to decide, so no apply-to-both.
    expect(q('deck-apply-both')).toBeNull();
    key('y');
    await flush();
    expect(onDecide).toHaveBeenCalledTimes(1);
    const input = onDecide.mock.calls[0][0];
    expect(input.decision).toBe('looks_right');
    expect(input.cells.map(c => c.key)).toEqual(['/app/missions/:id|mobile|']);
    // Not the fine desktop of the same route: the next screen in the queue.
    expect(focused()).toBe('/app/tasks/:id|mobile|');
    expect(q('deck-toast')).not.toBeNull();
  });

  it('a decision on a screen with two to review moves to its other viewport first', async () => {
    const { onDecide } = renderDeck({ model: bothUnsure('/app/settings'), startKey: '/app/settings|mobile|' });
    act(() => q('deck-apply-both')!.click());
    expect((q('deck-apply-both') as HTMLInputElement).checked).toBe(false);
    key('y');
    await flush();
    expect(onDecide.mock.calls[0][0].cells.map(c => c.key)).toEqual(['/app/settings|mobile|']);
    expect(focused()).toBe('/app/settings|desktop|');
  });

  it('applies to both viewports by default when their verdicts match', async () => {
    const { onDecide } = renderDeck({ model: bothUnsure('/app/settings'), startKey: '/app/settings|desktop|' });
    expect((q('deck-apply-both') as HTMLInputElement).checked).toBe(true);
    act(() => q('deck-looks-right')!.click());
    await flush();
    expect(onDecide.mock.calls[0][0].cells.map(c => c.key).sort()).toEqual(['/app/settings|desktop|', '/app/settings|mobile|']);
    expect(route()).not.toBe('/app/settings');
    expect(q('deck-toast-label')!.textContent).toContain('/app/settings, phone and desktop');
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

  it('agreeing with an issue is one tap (button or N); a note is optional from the toast', async () => {
    const { onDecide } = renderDeck({ startKey: '/app/settings|desktop|' });
    act(() => q('deck-needs-fix')!.click());
    await flush();
    expect(q('deck-note')).toBeNull();
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0][0]).toMatchObject({ decision: 'needs_fix' });
    expect(onDecide.mock.calls[0][0].cells.map(c => c.key)).toEqual(['/app/settings|desktop|']);
    expect('note' in onDecide.mock.calls[0][0]).toBe(false);
    // The optional guidance, from the undo toast.
    act(() => q('deck-add-note')!.click());
    const note = q('deck-note') as HTMLInputElement;
    expect(note.value).toBe('');
    typeInto(note, 'Keep the save bar sticky.');
    act(() => { note.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(onDecide).toHaveBeenCalledTimes(2);
    expect(onDecide.mock.calls[1][0]).toMatchObject({ decision: 'needs_fix', note: 'Keep the save bar sticky.' });
    expect(onDecide.mock.calls[1][0].cells.map(c => c.key)).toEqual(['/app/settings|desktop|']);
  });

  it('N on an issue decides at once too', async () => {
    const { onDecide } = renderDeck({ startKey: '/app/settings|desktop|' });
    key('n');
    await flush();
    expect(q('deck-note')).toBeNull();
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0][0].decision).toBe('needs_fix');
  });

  it('Needs fix on an ok screen opens an empty note that needs text to file', () => {
    const { onDecide } = renderDeck({ startKey: '/app/missions/:id|desktop|' });
    expect(focused()).toBe('/app/missions/:id|desktop|');
    act(() => q('deck-needs-fix')!.click());
    const note = q('deck-note') as HTMLInputElement;
    expect(note.value).toBe('');
    expect((q('deck-note-submit') as HTMLButtonElement).disabled).toBe(true);
    typeInto(note, 'The band is cut off.');
    expect((q('deck-note-submit') as HTMLButtonElement).disabled).toBe(false);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('the hints under the buttons say what each does, by the fix status', () => {
    const withFix = (status: string) => {
      const m = deckModel();
      return { ...m, cells: m.cells.map(c => (c.key === '/app/settings|desktop|' && c.current.fixTask ? { ...c, current: { ...c.current, fixTask: { ...c.current.fixTask, status } } } : c)) };
    };
    const copyFor = (status: string) => {
      act(() => root.render(<VisualReviewDeck key={status} model={withFix(status)} layout="sheet" startKey="/app/settings|desktop|" onDecide={okDecide()} onUndo={async () => ({ ok: true })} />));
      return `${q('deck-looks-right')!.textContent} | ${q('deck-needs-fix')!.textContent}`;
    };
    expect(copyFor('pending')).toContain('Cancel fix');
    expect(copyFor('pending')).toContain('Keep fix');
    expect(copyFor('in_progress')).toContain('Notify fix');
    expect(copyFor('running')).toContain('Notify fix');
    // A finished fix: both record only (the next screenshot re-checks it).
    expect(copyFor('completed')).toBe('Looks rightRecord only | Needs fixRecord only');
    // A failed fix solved nothing: Needs fix files a new one.
    expect(copyFor('failed')).toContain('File fix');
  });

  it('the toast states the outcome the server returned, and Saving until it answers', async () => {
    let resolve!: (r: DecideResult) => void;
    const slow = mock((_input: DecideInput) => new Promise<DecideResult>((r) => { resolve = r; }));
    renderDeck({ startKey: '/app/settings|desktop|', onDecide: slow });
    key('y');
    await flush();
    expect(q('deck-toast-outcome')!.textContent).toBe('Saving');
    expect(q('deck-toast-label')!.textContent).toContain('/app/settings, desktop');
    await act(async () => { resolve({ ok: true, reviewIds: ['g1'], fixTaskId: null, cancelledFixTaskId: null, guidanceTaskId: 'fix-a', outcome: 'fix_started' }); });
    await flush();
    expect(q('deck-toast-outcome')!.textContent).toBe('Not a bug. Fix already started; note sent to it.');

    // An older server sends no outcome: a cancel still reads as one, anything else as saved.
    const dropped = mock(async (input: DecideInput): Promise<DecideResult> => ({ ok: true, reviewIds: input.cells.map(() => 'd1'), fixTaskId: null, cancelledFixTaskId: 'fix-a', guidanceTaskId: null, outcome: null }));
    act(() => root.render(<VisualReviewDeck key="b" model={deckModel()} layout="sheet" startKey="/app/settings|desktop|" onDecide={dropped} onUndo={async () => ({ ok: true })} />));
    key('y');
    await flush();
    expect(q('deck-toast-outcome')!.textContent).toBe(OUTCOME_COPY.fix_cancelled);
  });

  it('every outcome reads as what changed: no second person, no exclamation, no round number', () => {
    for (const text of Object.values(OUTCOME_COPY)) {
      expect(text).toMatch(/\.$/);
      expect(text).not.toMatch(/!|\byou\b|\byour\b|round/i);
      expect(text.length).toBeLessThanOrEqual(60);
    }
  });

  it('apply-to-both names the other viewport and, when they differ, what the agent said', () => {
    const m = bothUnsure('/app/settings');
    const differ = { ...m, cells: m.cells.map(c => (c.key === '/app/settings|desktop|' ? { ...c, current: { ...c.current, agentVerdict: 'ok' as const } } : c)) };
    renderDeck({ model: differ, startKey: '/app/settings|mobile|' });
    const label = (q('deck-apply-both') as HTMLInputElement).closest('label')!.textContent;
    expect(label).toContain('Also apply to desktop');
    expect(label).toContain('agent: ok');
  });

  it('shows a 5 second undo; the button and U undo the decision just made', async () => {
    const { onUndo } = renderDeck({ undoMs: 120 });
    key('y');
    await flush();
    expect(q('deck-toast')!.textContent).toContain('Undo');
    act(() => q('deck-undo')!.click());
    await flush();
    expect(onUndo).toHaveBeenCalledWith(['r1']);
    // Back on the undone screen, which is in the queue again.
    expect(focused()).toBe('/app/missions/:id|mobile|');
    expect(q('deck-progress')!.textContent).toBe('2 to review');

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

  it('J and K walk only the routes awaiting a decision; the end lists the rest read-only', () => {
    const m = deckModel();
    renderDeck();
    const routes: string[] = [];
    for (let i = 0; i < 10 && !q('deck-end'); i++) { routes.push(route()!); key('j'); }
    expect(q('deck-end')).not.toBeNull();
    // Never a fine route (/app/tasks), a fix under way (/app/settings), a settled
    // one (/app/inbox), or one whose fix finished without a PR (/app/workspaces/:id).
    expect(routes).toEqual(['/app/missions/:id', '/app/tasks/:id']);
    expect(q('deck-end')!.textContent).toContain('2 to review');
    const rows = (id: string) => [...q(id)!.querySelectorAll<HTMLElement>('[data-testid="deck-settled-row"]')].map(r => r.dataset.cell);
    expect(rows('deck-group-fine').sort()).toEqual(m.cells.filter(c => c.standing === 'fine').map(c => c.key).sort());
    expect(rows('deck-group-fixing').sort()).toEqual(['/app/inbox|mobile|', '/app/settings|desktop|', '/app/workspaces/:id|desktop|']);
    expect(q('deck-group-fine')!.textContent).toContain('Already fine (5)');
    expect(q('deck-group-fixing')!.textContent).toContain('Fix under way (3)');
    expect(q('deck-group-fixing')!.textContent).toContain('Fix merged, waiting for a new screenshot');
    // Read-only: no buttons in the groups, and no batch accept.
    expect(q('deck-group-fine')!.querySelector('button')).toBeNull();
    expect(q('deck-accept-all')).toBeNull();
    key('k');
    expect(route()).toBe('/app/tasks/:id');
    key('k');
    expect(route()).toBe('/app/missions/:id');
    // Nothing before the head of the queue.
    expect((q('deck-prev') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a decided route drops out of reach: prev and next skip it, and the count goes down', async () => {
    renderDeck();
    expect(q('deck-progress')!.textContent).toBe('2 to review');
    key('y');
    await flush();
    expect(route()).toBe('/app/tasks/:id');
    expect(q('deck-progress')!.textContent).toBe('1 to review');
    // The decided route is behind, but prev does not go back to it.
    expect((q('deck-prev') as HTMLButtonElement).disabled).toBe(true);
    key('k');
    expect(route()).toBe('/app/tasks/:id');
    key('y');
    await flush();
    expect(q('deck-end')).not.toBeNull();
    expect(q('deck-progress')!.textContent).toBe('Nothing to review');
    expect(q('deck-end')!.textContent).toContain('Nothing to review');
    expect(q('deck-back')).toBeNull();
    // From the end, prev reaches nothing either: both routes are decided.
    expect((q('deck-prev') as HTMLButtonElement).disabled).toBe(true);
    key('k');
    expect(q('deck-end')).not.toBeNull();
  });

  it('opened on a screen outside the queue (from a thumbnail): its buttons work, then it is left behind', async () => {
    const { onDecide } = renderDeck({ startKey: '/app/tasks|desktop|' });
    expect(focused()).toBe('/app/tasks|desktop|');
    expect(q('deck-progress')!.textContent).toBe('2 to review');
    expect(q('deck-looks-right')).not.toBeNull();
    key('j');
    expect(route()).toBe('/app/missions/:id');
    key('k');
    // Prev does not return to it: it was never awaiting a decision.
    expect(route()).toBe('/app/missions/:id');
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('C toggles compare on a screen shot in two rounds, and swipe is off while comparing', () => {
    // A fix check opens on compare by itself; C closes it and opens it again.
    renderDeck({ startKey: '/app/tasks/:id|mobile|' });
    expect(q('visual-review-compare')).not.toBeNull();
    key('c');
    expect(q('visual-review-compare')).toBeNull();
    expect(q('visual-review-deck')!.dataset.swipe).toBe('on');
    key('c');
    expect(q('visual-review-compare')).not.toBeNull();
    expect(q('compare-fix')!.textContent).toContain('Header title overflows');
    expect(q('compare-fix')!.textContent).toContain('PR #1');
    expect(q('visual-review-deck')!.dataset.swipe).toBe('off');
    // The phone round chip sits above the frame, never over the screenshot.
    const chip = q('compare-showing')!;
    expect(chip.closest('[data-testid="compare-phone-frame"]')).toBeNull();
    expect(q('compare-phone-frame')!.querySelector('[data-testid="visual-review-img"]')).not.toBeNull();
    key('c');
    expect(q('visual-review-compare')).toBeNull();
    expect(q('visual-review-deck')!.dataset.swipe).toBe('on');
  });
});

describe('after a fix merges: the buttons follow the fix, never local state', () => {
  /** The deck fixture rebuilt with one fix task's status changed, so fixCheck is derived as the server would. */
  const withFixStatus = (id: string, status: string) => {
    const base = visualReviewFixtureInput('needs_you', { needsYou: 'unsure', scenario: 'deck' });
    return withFixtureImages(buildVisualReviewModel({ ...base, tasks: base.tasks.map(t => (t.id === id ? { ...t, status } : t)) }));
  };
  const buttons = () => [...q('deck-actions')!.querySelectorAll<HTMLElement>('button')].map(b => b.dataset.testid);

  it('pins the exact button set per fix state', () => {
    // Pending or in progress: Looks right / Needs fix, unchanged.
    renderDeck({ startKey: '/app/settings|desktop|' });
    expect(buttons()).toEqual(['deck-needs-fix', 'deck-looks-right']);

    // Merged, no screenshot since: no decision buttons at all.
    act(() => root.render(<VisualReviewDeck key="merged" model={deckModel()} layout="sheet" startKey="/app/inbox|mobile|" onDecide={okDecide()} onUndo={async () => ({ ok: true })} />));
    expect(focused()).toBe('/app/inbox|mobile|');
    expect(buttons()).toEqual([]);

    // Merged, new screenshot: Fixed / Still broken.
    act(() => root.render(<VisualReviewDeck key="check" model={deckModel()} layout="sheet" startKey="/app/tasks/:id|mobile|" onDecide={okDecide()} onUndo={async () => ({ ok: true })} />));
    expect(buttons()).toEqual(['deck-still-broken', 'deck-fixed']);
    expect(q('deck-still-broken')!.textContent).toContain('Still broken');
    expect(q('deck-fixed')!.textContent).toContain('Fixed');

    // Failed or cancelled: Looks right / Needs fix, with the outcome shown.
    for (const status of ['failed', 'cancelled']) {
      act(() => root.render(<VisualReviewDeck key={status} model={withFixStatus('fixture-fix-2', status)} layout="sheet" startKey="/app/settings|desktop|" onDecide={okDecide()} onUndo={async () => ({ ok: true })} />));
      expect(buttons()).toEqual(['deck-needs-fix', 'deck-looks-right']);
      const fix = qa('deck-fix').find(f => f.closest('[data-viewport="desktop"]'))!;
      expect(fix.textContent?.toLowerCase()).toContain(status);
    }
  });

  it('merged with no screenshot since: settled, says so in plain words, links the fix and PR, keys do nothing', async () => {
    const { onDecide } = renderDeck({ startKey: '/app/inbox|mobile|' });
    expect(q('deck-settled')!.textContent).toBe('Fix merged, waiting for a new screenshot');
    const fix = q('deck-fix')!;
    expect(fix.textContent).toContain('The unread badge overlaps the sender name.');
    expect(fix.textContent).toContain('PR #3, merged');
    expect(fix.querySelector('a[href="https://example.test/pulls/3"]')).not.toBeNull();
    expect(q('visual-review-deck')!.textContent).not.toMatch(/round/i);
    key('y');
    key('n');
    await flush();
    expect(onDecide).not.toHaveBeenCalled();
    expect(q('deck-note')).toBeNull();
  });

  it('a new screenshot after the merge opens on Before / After with no round named', () => {
    renderDeck({ startKey: '/app/tasks/:id|mobile|' });
    const compare = q('visual-review-compare')!;
    expect(compare.dataset.fixCheck).toBe('true');
    expect(q('compare-fix')!.textContent).toContain('The fix');
    expect(q('compare-fix')!.textContent).toContain('PR #1');
    expect(q('deck-round')).toBeNull();
    expect(q('compare-showing')!.textContent).toBe('After');
    expect(q('visual-review-deck')!.textContent).not.toMatch(/round/i);
    // Closed, the button names what it shows.
    key('c');
    expect(q('deck-compare')!.textContent).toContain('Before / After');
    expect(q('visual-review-deck')!.textContent).not.toMatch(/round/i);
  });

  it('Still broken opens the note prefilled with what the merged fix was for, and files it', async () => {
    const { onDecide } = renderDeck({ startKey: '/app/tasks/:id|mobile|' });
    // The desktop is fine by the agent: nothing to decide there, so no apply-to-both.
    expect(q('deck-apply-both')).toBeNull();
    act(() => q('deck-still-broken')!.click());
    const note = q('deck-note') as HTMLInputElement;
    expect(note.value).toBe('Header title overflows the viewport by about 40px.');
    expect(q('deck-note-submit')!.textContent).toBe('File fix');
    act(() => { note.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(onDecide.mock.calls[0][0]).toMatchObject({ decision: 'needs_fix', note: 'Header title overflows the viewport by about 40px.' });
    expect(onDecide.mock.calls[0][0].cells.map(c => c.key)).toEqual(['/app/tasks/:id|mobile|']);
    expect(q('deck-toast-label')!.textContent).toBe('/app/tasks/:id, phoneSaved.');
  });

  it('Fixed records the decision with no note', async () => {
    const { onDecide } = renderDeck({ startKey: '/app/tasks/:id|mobile|' });
    key('y');
    await flush();
    expect(onDecide.mock.calls[0][0]).toMatchObject({ decision: 'looks_right' });
    expect('note' in onDecide.mock.calls[0][0]).toBe(false);
    expect(q('deck-toast-label')!.textContent).toBe('/app/tasks/:id, phoneSaved.');
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
    const m = deckModel();
    const target = '/app/missions/:id|mobile|';
    // The server's fresh model: the agent re-judged the screen as an issue.
    const fresh: VisualReviewModel = {
      ...m,
      generatedAt: new Date(Date.parse(m.generatedAt) + 1000).toISOString(),
      cells: m.cells.map(c => (c.key === target ? { ...c, effectiveVerdict: 'issue', needsHuman: false, current: { ...c.current, agentVerdict: 'issue', finding: 'Re-judged: the second heading is a bug.' } } : c)),
    };
    const decide = mock(async () => {
      throw new VisualReviewRequestError(409, { error: 'stale', stale: true, cells: fresh.cells.filter(c => c.key === target), model: fresh });
    });
    const transport: Transport = { decide, undo: async () => { throw new Error('unused'); } };
    act(() => root.render(<Connected transport={transport} model={m} />));
    expect(q('deck-looks-right')!.dataset.effect).toBe('waive');
    key('y');
    await flush();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(q('deck-notice')!.textContent).toContain('Screen changed since it loaded');
    expect(focused()).toBe(target);
    const finding = document.querySelector<HTMLElement>('[data-focused-shot="true"] [data-testid="deck-finding"]')!;
    expect(finding.textContent).toBe('Re-judged: the second heading is a bug.');
    expect(q('deck-looks-right')!.dataset.effect).toBe('dispute');
    expect(q('deck-needs-fix')!.dataset.effect).toBe('agree');
    await flush();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest server model when two decisions resolve out of order', async () => {
    const m = deckModel();
    const a = m.cells.find(c => c.key === '/app/missions/:id|mobile|')!;
    const b = m.cells.find(c => c.key === '/app/missions/:id|desktop|')!;
    const t0 = Date.parse(m.generatedAt);
    // A commits first, so its model has only A; B's model has both.
    const modelA = { ...applyOptimisticDecision(m, { cells: [a], decision: 'looks_right' }, 'a').model, generatedAt: new Date(t0 + 1000).toISOString() };
    const modelB = { ...applyOptimisticDecision(modelA, { cells: [b], decision: 'looks_right' }, 'b').model, generatedAt: new Date(t0 + 2000).toISOString() };
    const resolvers: Record<string, () => void> = {};
    const transport: Transport = {
      decide: req => new Promise((res) => {
        const which = req.artifactIds[0] === a.current.shot.id ? 'a' : 'b';
        const model = which === 'a' ? modelA : modelB;
        resolvers[which] = () => res({ reviews: [], fixTaskId: null, cancelledFixTaskId: null, guidanceTaskId: null, model });
      }),
      undo: async () => { throw new Error('unused'); },
    };
    let seen: VisualReviewModel | null = null;
    const adopted: string[] = [];
    function Probe() {
      const d = useVisualReviewDecisions(m, transport, { onModel: mm => adopted.push(mm.generatedAt) });
      seen = d.model;
      return <VisualReviewDeck model={d.model} layout="sheet" onDecide={d.decide} onUndo={d.undo} />;
    }
    act(() => root.render(<Probe />));
    key('y');
    await flush();
    key('y');
    await flush();
    await act(async () => { resolvers.b(); });
    await flush();
    await act(async () => { resolvers.a(); });
    await flush();
    const reviewed = (k: string) => !!seen!.cells.find(c => c.key === k)!.current.review;
    expect(reviewed(a.key)).toBe(true);
    expect(reviewed(b.key)).toBe(true);
    expect(seen!.generatedAt).toBe(modelB.generatedAt);
    // The late, older model was not handed on either.
    expect(adopted).toEqual([modelB.generatedAt]);
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
    expect(q('deck-progress')!.textContent).toBe(`${toReview(m) - 1} to review`);
    await act(async () => { reject(new VisualReviewRequestError(500, { error: 'boom' })); });
    await flush();
    expect(q('deck-progress')!.textContent).toBe(`${toReview(m)} to review`);
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
    expect(q('deck-progress')!.textContent).toBe(`${toReview(m) - 1} to review`);
    expect(t.model().fixTasks.some(f => f.status === 'pending' && f.title.startsWith('[surface fix] /app/missions/:id:'))).toBe(true);
    expect(q('deck-toast-outcome')!.textContent).toBe('Fix filed. Open until re-checked.');
    act(() => q('deck-undo')!.click());
    await flush();
    expect(q('deck-progress')!.textContent).toBe(`${toReview(m)} to review`);
    expect(t.model().fixTasks.filter(f => f.title.startsWith('[surface fix] /app/missions/:id:')).every(f => f.status === 'cancelled')).toBe(true);
  });
});

describe('dev mode', () => {
  it('under StrictMode the outcome still lands (the mounted guard survives the simulated remount)', async () => {
    const { StrictMode } = await import('react');
    const t = createFixtureVisualReviewTransport('needs_you', { scenario: 'deck' }, { latencyMs: 50 });
    act(() => root.render(<StrictMode><Connected transport={t} model={t.model()} /></StrictMode>));
    key('y');
    await wait(200);
    await flush();
    expect(q('deck-toast-outcome')!.textContent).toBe('Marked fine.');
  });
});

describe('undo over the real server contract', () => {
  it('takes back a two-viewport tap with one call, not one per row', async () => {
    const base = createFixtureVisualReviewTransport('needs_you', { needsYou: 'unsure', scenario: 'deck' });
    const calls: string[] = [];
    const transport: Transport = { ...base, undo: async (id: string) => { calls.push(id); return base.undo(id); } };
    let api: ReturnType<typeof useVisualReviewDecisions> | null = null;
    const initial = base.model();
    function Harness() { api = useVisualReviewDecisions(initial, transport); return null; }
    act(() => root.render(<Harness />));
    const pair = base.model().cells.filter(c => c.route === '/app/missions/:id');
    let ids: string[] = [];
    await act(async () => {
      const res = await transport.decide(buildDecisionRequest({ cells: pair, decision: 'needs_fix' }));
      ids = res.reviews.map(r => r.id);
    });
    expect(ids).toHaveLength(2);
    let out: Awaited<ReturnType<NonNullable<typeof api>['undo']>> | null = null;
    await act(async () => { out = await api!.undo(ids); });
    expect(out).toEqual({ ok: true });
    expect(calls).toEqual([ids[0]]);
  });
});
