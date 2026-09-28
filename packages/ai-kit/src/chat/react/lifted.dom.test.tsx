/**
 * The components lifted from buildd's chat in 0.5.0, mounted (happy-dom):
 * TurnFeedback, SteerComposer, the object renderers and pinned strip, and the
 * composer's new slots. Runs in its own process (scripts/run-unit-tests.ts),
 * so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/chat' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const h = createElement as (type: unknown, props?: unknown, ...children: unknown[]) => any;
const { createRoot } = await import('react-dom/client');
const kit = await import('./index');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const render = async (el: unknown) => { await act(async () => { root.render(el as never); }); };
const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const type = async (el: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const enter = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
};

const realMatch = window.matchMedia;
const desktop = () => { (window as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }); };
const phone = () => { (window as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: q.includes('max-width: 639px'), media: q, addEventListener() {}, removeEventListener() {} }); };

beforeEach(() => {
  desktop();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  (window as { matchMedia: unknown }).matchMedia = realMatch;
});

// ── TurnFeedback ──────────────────────────────────────────────────────────────

describe('TurnFeedback', () => {
  const MSG = 'msg-1';
  const mount = async (props: Record<string, unknown> = {}, events: unknown[] = []) => {
    await render(h(kit.TurnFeedbackProvider, { onFeedback: (e: unknown) => { events.push(e); }, initial: {}, messageIds: [MSG], ...props },
      h(kit.TurnFeedback, { messageId: MSG })));
    return events;
  };

  it('a thumbs-up records at once', async () => {
    const events = await mount();
    await click($('[data-testid="kit-feedback-up"]'));
    expect(events).toEqual([{ messageId: MSG, signal: 'up', reason: null, previous: null, cleared: false }]);
    expect($('[data-testid="kit-feedback"]')!.dataset.vote).toBe('up');
    expect($('[data-testid="kit-feedback-up"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('a thumbs-down records, offers the reasons, and Send records the reason key', async () => {
    const events = await mount();
    await click($('[data-testid="kit-feedback-down"]'));
    expect(events).toHaveLength(1);
    expect((events[0] as { signal: string }).signal).toBe('down');
    const labels = $$('[data-testid="kit-feedback-reason"]').map(e => e.textContent);
    expect(labels).toEqual(kit.DEFAULT_FEEDBACK_REASONS.map(r => r.label));
    // Send does nothing until a reason is picked.
    await click($('[data-testid="kit-feedback-send"]'));
    expect(events).toHaveLength(1);
    expect($('[data-testid="kit-feedback-sheet"]')).not.toBeNull();
    await click($('[data-reason="made_up"]')!.closest('button'));
    await click($('[data-testid="kit-feedback-send"]'));
    expect(events[1]).toEqual({ messageId: MSG, signal: 'down', reason: 'made_up', previous: { signal: 'down', reason: null }, cleared: false });
    expect($('[data-testid="kit-feedback-sheet"]')).toBeNull();
    expect($('[data-testid="kit-feedback"]')!.dataset.reason).toBe('made_up');
    expect($('.kit-feedback-reason')!.textContent).toBe('Made something up');
  });

  it('Skip closes with the plain thumbs-down kept', async () => {
    const events = await mount();
    await click($('[data-testid="kit-feedback-down"]'));
    await click($('[data-testid="kit-feedback-skip"]'));
    expect(events).toHaveLength(1);
    expect($('[data-testid="kit-feedback-sheet"]')).toBeNull();
    expect($('[data-testid="kit-feedback"]')!.dataset.vote).toBe('down');
  });

  it('the same thumb again takes it back (cleared)', async () => {
    const events = await mount();
    await click($('[data-testid="kit-feedback-up"]'));
    await click($('[data-testid="kit-feedback-up"]'));
    expect(events).toHaveLength(2);
    expect((events[1] as { cleared: boolean }).cleared).toBe(true);
    expect($('[data-testid="kit-feedback"]')!.dataset.vote).toBe('');
  });

  it('a vote the app refuses rolls back', async () => {
    await render(h(kit.TurnFeedbackProvider, { onFeedback: async () => false, initial: {} }, h(kit.TurnFeedback, { messageId: MSG })));
    await click($('[data-testid="kit-feedback-up"]'));
    await settle();
    expect($('[data-testid="kit-feedback"]')!.dataset.vote).toBe('');
  });

  it('a vote whose recording throws rolls back to the vote before it', async () => {
    await render(h(kit.TurnFeedbackProvider, { onFeedback: async () => { throw new Error('offline'); }, initial: { [MSG]: { signal: 'down', reason: 'too_slow' } } },
      h(kit.TurnFeedback, { messageId: MSG })));
    await click($('[data-testid="kit-feedback-up"]'));
    await settle();
    expect($('[data-testid="kit-feedback"]')!.dataset.vote).toBe('down');
    expect($('[data-testid="kit-feedback"]')!.dataset.reason).toBe('too_slow');
  });

  it('loads the votes already cast through loadVotes, not a fetch', async () => {
    const asked: string[][] = [];
    await render(h(kit.TurnFeedbackProvider, {
      onFeedback() {}, messageIds: [MSG, 'msg-2'],
      loadVotes: async (ids: string[]) => { asked.push([...ids]); return { [MSG]: { signal: 'down', reason: 'too_slow' } }; },
    }, h(kit.TurnFeedback, { messageId: MSG })));
    await settle();
    expect(asked).toEqual([[MSG, 'msg-2']]);
    expect($('[data-testid="kit-feedback"]')!.dataset.vote).toBe('down');
    expect($('.kit-feedback-reason')!.textContent).toBe('Too slow');
  });

  it('custom reasons and a still-streaming turn with no thumbs', async () => {
    await mount({ reasons: [{ key: 'off_topic', label: 'Off topic' }] });
    await click($('[data-testid="kit-feedback-down"]'));
    expect($$('[data-testid="kit-feedback-reason"]').map(e => e.textContent)).toEqual(['Off topic']);
    await mount({ pendingId: MSG });
    expect($('[data-testid="kit-feedback"]')).toBeNull();
  });

  it('renders nothing without a provider', async () => {
    await render(h(kit.TurnFeedback, { messageId: MSG }));
    expect(container.innerHTML).toBe('');
  });

  it('on a phone the reasons open as a sheet portaled to <body>; Escape closes it', async () => {
    phone();
    await mount();
    await click($('[data-testid="kit-feedback-down"]'));
    const layer = document.querySelector<HTMLElement>('body > [data-testid="kit-feedback-layer"]');
    expect(layer).not.toBeNull();
    expect(layer!.querySelector('[data-testid="kit-feedback-sheet"]')!.getAttribute('data-sheet')).toBe('true');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[data-testid="kit-feedback-layer"]')).toBeNull();
  });
});

// ── SteerComposer ─────────────────────────────────────────────────────────────

describe('SteerComposer', () => {
  it('sends to onSend (not a chat turn), clears the draft, and lists messages with their delivery', async () => {
    const sent: string[] = [];
    const messages = [{ id: 'a', text: 'use the staging db', status: 'delivered' }, { id: 'b', text: null, status: 'sent' }];
    await render(h(kit.SteerComposer, {
      onSend: async (t: string) => { sent.push(t); },
      messages,
      title: kit.steerTitle('Builder', 'atlas', 'rates service'),
      presence: [{ key: 'runner', label: 'atlas', tone: 'strong' }, { key: 'action', label: 'Running tests', tone: 'live' }],
    }));
    expect($('[data-testid="kit-steer-title"]')!.textContent).toBe('Builder @ atlas / rates service');
    expect($$('.kit-steer-presence-item').map(e => e.textContent)).toEqual(['atlas', 'Running tests']);
    const rows = $$('[data-testid="kit-steer-message"]');
    expect(rows.map(r => r.dataset.status)).toEqual(['delivered', 'sent']);
    expect(rows.map(r => r.querySelector('.kit-steer-status')!.textContent)).toEqual(['Delivered', 'Sent']);
    expect(rows[1].querySelector('.kit-text')!.textContent).toBe('(hidden)');

    const input = $('[data-testid="kit-steer-input"]') as HTMLTextAreaElement;
    expect($('[data-testid="kit-steer-send"]')!.getAttribute('aria-disabled')).toBe('true');
    await type(input, '  skip the flaky test  ');
    expect($('[data-testid="kit-steer-send"]')!.getAttribute('aria-disabled')).toBeNull();
    await enter(input);
    await settle();
    expect(sent).toEqual(['skip the flaky test']);
    expect(input.value).toBe('');
  });

  it('a failed send shows the error and keeps the draft', async () => {
    await render(h(kit.SteerComposer, { onSend: async () => { throw new Error('Agent is gone'); }, messages: [] }));
    const input = $('[data-testid="kit-steer-input"]') as HTMLTextAreaElement;
    await type(input, 'hello');
    await click($('[data-testid="kit-steer-send"]'));
    await settle();
    expect($('[data-testid="kit-steer-error"]')!.textContent).toBe('Agent is gone');
    expect(input.value).toBe('hello');
  });

  it('blocked: the box says why, is disabled, and never sends', async () => {
    const sent: string[] = [];
    await render(h(kit.SteerComposer, { onSend: (t: string) => { sent.push(t); }, messages: [], blockedReason: 'No agent is running on this right now.' }));
    const input = $('[data-testid="kit-steer-input"]') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('No agent is running on this right now.');
    await click($('[data-testid="kit-steer-send"]'));
    expect(sent).toEqual([]);
    expect($('[data-testid="kit-steer"]')!.dataset.blocked).toBe('true');
    expect($('.kit-note')!.textContent).toContain('Nothing sent yet');
  });

  it('canSteer and steerTitle', () => {
    expect(kit.canSteer({ draft: 'x', sending: false })).toBe(true);
    expect(kit.canSteer({ draft: ' ', sending: false })).toBe(false);
    expect(kit.canSteer({ draft: 'x', sending: true })).toBe(false);
    expect(kit.canSteer({ draft: 'x', sending: false, blockedReason: 'no' })).toBe(false);
    expect(kit.steerTitle(null, null, 'work')).toBe('Agent / work');
  });
});

// ── Objects ───────────────────────────────────────────────────────────────────

describe('objects', () => {
  type View = { kind: string; name: string; state: string };
  const ref = { kind: 'order', id: 'o1', workspaceId: null, fallbackText: 'Order o1' };
  const views: Record<string, View> = { 'order:o1': { kind: 'order', name: 'Blue mugs', state: 'Packing' } };
  const memory = () => {
    let loads = 0;
    return {
      loads: () => loads,
      source: { async load(r: { kind: string; id: string }) { loads++; const v = views[`${r.kind}:${r.id}`]; if (!v) throw new Error('Not found'); return v; } },
    };
  };
  const renderers = {
    order: {
      card: (_r: unknown, v: View) => h('div', { 'data-testid': 'order-card' }, v.name),
      pane: (_r: unknown, v: View, variant: string) => h('div', { 'data-testid': 'order-pane', 'data-variant': variant }, v.name),
      matches: (r: { kind: string }, v: View) => v.kind === r.kind,
    },
  };

  it('a card and a pinned strip for the same ref share one load; the app renders the kind', async () => {
    const m = memory();
    const store = kit.createObjectStore(m.source as never);
    const opened: string[] = [];
    await render(h(kit.ObjectStoreProvider, { store },
      h(kit.PinnedObject, {
        objRef: ref, onOpen: () => opened.push('open'),
        titleOf: (v: View) => v.name,
        state: (v: View) => h('span', { 'data-testid': 'chip' }, v.state),
        meta: () => '3 items',
        detail: (v: View) => h('p', { 'data-testid': 'detail' }, `${v.name} detail`),
      }),
      h(kit.ObjectCard, { objRef: ref, renderers })));
    await settle();
    expect(m.loads()).toBe(1);
    expect($('[data-testid="order-card"]')!.textContent).toBe('Blue mugs');
    expect($('[data-testid="kit-pinned-title"]')!.textContent).toBe('Blue mugs');
    expect($('.kit-pinned-desk .kit-pinned-kind')!.textContent).toBe('Pinned · order');
    expect($('.kit-pinned-phone .kit-pinned-kind')!.textContent).toBe('order');
    expect($$('[data-testid="chip"]').length).toBe(2);
    expect($('.kit-pinned-meta')!.textContent).toBe('3 items');
    expect($('[data-testid="detail"]')).not.toBeNull();
    await click($('[data-testid="kit-pinned-toggle"]'));
    expect($('[data-testid="detail"]')).toBeNull();
    expect($('[data-testid="kit-pinned-toggle"]')!.textContent).toBe('Show');
    await click($('[data-testid="kit-pinned-open"]'));
    await click($('[data-testid="kit-pinned-open-sheet"]'));
    expect(opened).toEqual(['open', 'open']);
  });

  it('before the view loads the strip shows the ref title; openLabel null hides the button; no detail, no toggle', async () => {
    const store = kit.createObjectStore({ load: () => new Promise(() => {}) } as never);
    await render(h(kit.ObjectStoreProvider, { store }, h(kit.PinnedObject, { objRef: { ...ref, title: 'Mugs order' }, onOpen() {}, openLabel: null, hideOnDesktop: true })));
    expect($('[data-testid="kit-pinned-title"]')!.textContent).toBe('Mugs order');
    expect($('[data-testid="kit-pinned-open"]')).toBeNull();
    expect($('[data-testid="kit-pinned-toggle"]')).toBeNull();
    expect($('[data-testid="kit-pinned"]')!.dataset.hideDesktop).toBe('true');
  });

  it('pane passes the variant; an unknown kind, a mismatched view or a failed load shows the fallback', async () => {
    const m = memory();
    const store = kit.createObjectStore(m.source as never);
    await render(h(kit.ObjectStoreProvider, { store },
      h(kit.ObjectPane, { objRef: ref, renderers, variant: 'sheet' }),
      h(kit.ObjectCard, { objRef: { kind: 'invoice', id: 'i1', workspaceId: null, fallbackText: 'Invoice i1' }, renderers }),
      h(kit.ObjectCard, { objRef: { kind: 'order', id: 'gone', workspaceId: null, fallbackText: 'Order gone' }, renderers })));
    await settle();
    expect($('[data-testid="order-pane"]')!.dataset.variant).toBe('sheet');
    const placeholders = $$('[data-testid="kit-object-placeholder"]');
    expect(placeholders.map(p => p.firstElementChild!.textContent)).toEqual(['Invoice i1', 'Order gone']);
    expect(placeholders[1].textContent).toContain('Not found');
  });

  it('pinnedObjectTitle: the app title, else the ref title, else the fallback', () => {
    expect(kit.pinnedObjectTitle(ref, { name: 'x' }, (v: { name: string }) => v.name)).toBe('x');
    expect(kit.pinnedObjectTitle({ ...ref, title: 'T' }, null)).toBe('T');
    expect(kit.pinnedObjectTitle(ref, null)).toBe('Order o1');
  });
});

// ── Composer slots ────────────────────────────────────────────────────────────

describe('ChatComposer extension slots', () => {
  it('leading, actions, edge and footer render where they belong; mood and compact land as data', async () => {
    await render(h(kit.ChatComposer, {
      onSend() {},
      leading: h('span', { 'data-testid': 'chip' }, 'About: Blue mugs'),
      actions: h('button', { type: 'button', 'data-testid': 'attach' }, 'Attach'),
      edge: h('span', { 'data-testid': 'sweep' }),
      footer: h('span', { 'data-testid': 'hints' }, 'Enter sends'),
      tier: h('span', null, 'Auto'),
      mood: 'needs',
      compact: true,
    }));
    const form = $('[data-testid="kit-composer"]')!;
    expect(form.dataset.mood).toBe('needs');
    expect(form.dataset.compact).toBe('true');
    // Leading sits inside the box, above the message.
    const leading = $('[data-testid="kit-composer-leading"]')!;
    expect(leading.contains($('[data-testid="chip"]'))).toBe(true);
    expect(leading.compareDocumentPosition($('[data-testid="kit-composer-input"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Actions come after tier, before Send.
    const slots = $$('.kit-toolbar > *').map(e => e.dataset.slot ?? e.dataset.testid);
    expect(slots).toEqual(['scope', 'tier', 'actions', 'kit-send']);
    expect($('[data-testid="kit-composer-edge"]')!.getAttribute('aria-hidden')).toBe('true');
    // Footer is outside the form.
    expect(form.contains($('[data-testid="hints"]'))).toBe(false);
    expect($('[data-testid="kit-composer-footer"]')!.textContent).toBe('Enter sends');
  });

  it('without the new props nothing new renders', async () => {
    await render(h(kit.ChatComposer, { onSend() {} }));
    for (const id of ['kit-composer-leading', 'kit-composer-edge', 'kit-composer-footer']) expect($(`[data-testid="${id}"]`)).toBeNull();
    expect($('[data-slot="actions"]')).toBeNull();
    const form = $('[data-testid="kit-composer"]')!;
    expect(form.dataset.mood).toBeUndefined();
    expect(form.dataset.compact).toBeUndefined();
  });
});
