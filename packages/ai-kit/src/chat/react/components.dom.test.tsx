/**
 * The `/chat/react` components, mounted (happy-dom). Runs in its own process
 * (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/chat' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
// Props are checked by the components' own types; the fixtures here are loose on purpose.
const h = createElement as (type: unknown, props?: unknown, ...children: unknown[]) => any;
const { createRoot } = await import('react-dom/client');
const kit = await import('./index');
const { encodeApprovalPreview } = await import('@builddai/ai-kit/chat/contract');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const render = async (el: unknown) => { await act(async () => { root.render(el as never); }); };
const $ = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel as never) as T | null;
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };
const type = async (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const key = async (el: Element, k: string, extra: KeyboardEventInit = {}) => {
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })); });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const rows = [
  { key: 'planner', label: 'Planner', mode: 'allow' as const, locked: false },
  { key: 'email', label: 'Email', mode: 'ask' as const, locked: false },
  { key: 'search', label: 'Search', mode: 'read' as const, locked: true },
  { key: 'keys', label: 'Keys', mode: 'never' as const, locked: true },
];

describe('ToolsMenu', () => {
  it('is a plain "Tools" ··· trigger, opens the rows, toggles, and closes on Escape back to the trigger', async () => {
    const changes: string[] = [];
    await render(h(kit.ToolsMenu, { rows, onChange: (k: string, m: string) => changes.push(`${k}:${m}`) }));
    const trigger = $('[data-testid="kit-tools-trigger"]')!;
    expect(trigger.getAttribute('aria-label')).toBe('Tools');
    expect(trigger.textContent).toBe('···');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const panel = $('[data-testid="kit-tools-panel"]')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect($('[data-group="search"] .kit-row-lock')!.textContent).toBe('Read only');
    expect($('[data-group="keys"] .kit-row-lock')!.textContent).toBe('Never');
    const allowEmail = [...$$('[data-group="email"] button')].find(b => b.textContent === 'Allow')!;
    expect(allowEmail.getAttribute('aria-pressed')).toBe('false');
    await click(allowEmail);
    expect(changes).toEqual(['email:allow']);
    // Pressing the mode that's already on does nothing.
    await click([...$$('[data-group="planner"] button')].find(b => b.textContent === 'Allow')!);
    expect(changes).toEqual(['email:allow']);
    await key(document.body, 'Escape');
    expect($('[data-testid="kit-tools-panel"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('on a phone: a bottom sheet portaled to <body> with the --kit-* values from where it opened; the scrim closes it', async () => {
    const realMatch = window.matchMedia;
    (window as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: q.includes('max-width: 639px'), media: q, addEventListener() {}, removeEventListener() {} });
    try {
      const changes: string[] = [];
      await render(h(kit.ToolsMenu, { rows, onChange: (k: string, m: string) => changes.push(`${k}:${m}`) }));
      // (Set on the menu itself: happy-dom's computed style doesn't inherit custom properties; browsers do.)
      $('[data-testid="kit-tools"]')!.style.setProperty('--kit-bg', 'rebeccapurple');
      $('[data-testid="kit-tools"]')!.style.setProperty('--kit-sheet-bottom-offset', '64px');
      await click($('[data-testid="kit-tools-trigger"]'));
      expect($('[data-testid="kit-tools-panel"]')).toBeNull(); // not inside the composer
      const layer = document.querySelector<HTMLElement>('body > [data-testid="kit-tools-sheet"]')!;
      expect(layer).not.toBeNull();
      expect(layer.classList.contains('kit-chat')).toBe(true);
      expect(layer.style.getPropertyValue('--kit-bg')).toBe('rebeccapurple');
      expect(layer.style.getPropertyValue('--kit-sheet-bottom-offset')).toBe('64px');
      const panel = layer.querySelector('[data-testid="kit-tools-panel"]')!;
      expect(panel.getAttribute('data-sheet')).toBe('true');
      // A click inside the sheet is not "outside".
      await click([...panel.querySelectorAll('[data-group="email"] button')].find(b => b.textContent === 'Allow')!);
      expect(changes).toEqual(['email:allow']);
      expect(document.querySelector('[data-testid="kit-tools-sheet"]')).not.toBeNull();
      await act(async () => { layer.querySelector('.kit-sheet-scrim')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
      expect(document.querySelector('[data-testid="kit-tools-sheet"]')).toBeNull();
    } finally {
      (window as { matchMedia: unknown }).matchMedia = realMatch;
    }
  });

  it('carries no Allow count, however many groups are on Allow', async () => {
    const allAllowed = rows.map(r => (r.locked ? r : { ...r, mode: 'allow' as const }));
    await render(h(kit.ToolsMenu, { rows: allAllowed, onChange() {} }));
    expect($('[data-testid="kit-tools-count"]')).toBeNull();
    expect($('.kit-badge')).toBeNull();
    const trigger = $('[data-testid="kit-tools-trigger"]')!;
    expect(trigger.textContent).toBe('···');
    expect(trigger.getAttribute('aria-label')).toBe('Tools');
  });
});

describe('ScopePicker and TierPicker', () => {
  it('scope: "@ all", "→ routed", "@ pinned", and picking an option', async () => {
    const picked: Array<string | null> = [];
    const opts = [{ id: 'w1', name: 'home' }, { id: 'w2', name: 'work' }];
    await render(h(kit.ScopePicker, { options: opts, value: null, onChange: (v: string | null) => picked.push(v) }));
    expect($('[data-testid="kit-scope-trigger"]')!.textContent).toContain('@ all');
    await render(h(kit.ScopePicker, { options: opts, value: null, routed: opts[1], onChange: (v: string | null) => picked.push(v) }));
    expect($('[data-testid="kit-scope-trigger"]')!.textContent).toContain('→ work');
    await click($('[data-testid="kit-scope-trigger"]'));
    await click([...$$('[role="radio"]')].find(b => b.textContent === 'home')!);
    expect(picked).toEqual(['w1']);
    expect($('[data-testid="kit-scope-panel"]')).toBeNull();
  });

  it('tier: Auto, Auto · Standard after a turn, a pinned tier, prices as meta', async () => {
    const picked: Array<string | null> = [];
    await render(h(kit.TierPicker, { value: null, last: 'standard', onChange: (v: string | null) => picked.push(v), options: [{ tier: 'budget', price: '$0.001' }, { tier: 'premium' }] }));
    expect($('[data-testid="kit-tier-trigger"]')!.textContent).toContain('Auto · Standard');
    await click($('[data-testid="kit-tier-trigger"]'));
    expect($('[aria-checked="true"]')!.textContent).toContain('Auto');
    expect($$('.kit-option-meta').map(e => e.textContent)).toContain('$0.001');
    await click([...$$('[role="radio"]')].find(b => b.textContent!.startsWith('Premium'))!);
    expect(picked).toEqual(['premium']);
  });

  it('tier with a policy: no Auto, the app names, only offered rows, meta kept', async () => {
    const picked: Array<string | null> = [];
    const policy = kit.defineTierPolicy({ defaultTier: 'budget', auto: false, labels: { budget: 'Economy', standard: 'Balanced', premium: 'Best' } });
    const options = [{ tier: 'budget', price: 'Haiku' }, { tier: 'standard' }, { tier: 'premium' }, { tier: 'premium-plus' }];
    await render(h(kit.TierPicker, { value: 'budget', last: 'standard', policy, options, onChange: (v: string | null) => picked.push(v) }));
    const trigger = $('[data-testid="kit-tier-trigger"]')!;
    expect(trigger.textContent).toContain('Economy');
    expect(trigger.getAttribute('aria-label')).toBe('Model tier: Economy');
    await click(trigger);
    expect($$('[role="radio"]').map(b => b.textContent)).toEqual(['EconomyHaiku', 'Balanced', 'Best']);
    await click([...$$('[role="radio"]')].find(b => b.textContent === 'Best')!);
    expect(picked).toEqual(['premium']);
  });

  it('tier with a policy and no options lists the policy tiers', async () => {
    const policy = kit.defineTierPolicy({ offer: ['budget', 'standard'], labels: { budget: 'Economy' }, autoLabel: 'Pick for me' });
    await render(h(kit.TierPicker, { value: null, policy, onChange() {} }));
    expect($('[data-testid="kit-tier-trigger"]')!.textContent).toContain('Pick for me');
    await click($('[data-testid="kit-tier-trigger"]'));
    expect($$('[role="radio"]').map(b => b.textContent)).toEqual(['Pick for mepicks per turn', 'Economy', 'Standard']);
  });
});

describe('ChatComposer', () => {
  it('Enter sends and clears; Shift+Enter does not; empty does not send', async () => {
    const sent: string[] = [];
    await render(h(kit.ChatComposer, { onSend: (t: string) => sent.push(t) }));
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    await key(box, 'Enter');
    expect(sent).toEqual([]);
    await type(box, 'hello');
    await key(box, 'Enter', { shiftKey: true });
    expect(sent).toEqual([]);
    await key(box, 'Enter');
    expect(sent).toEqual(['hello']);
    expect(box.value).toBe('');
    expect($('[data-testid="kit-send"]')!.getAttribute('aria-disabled')).toBe('true');
  });

  it('busy: Send becomes Stop, Enter holds the draft', async () => {
    const sent: string[] = [];
    let stopped = 0;
    await render(h(kit.ChatComposer, { busy: true, onSend: (t: string) => sent.push(t), onStop: () => { stopped++; } }));
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    await type(box, 'next question');
    await key(box, 'Enter');
    expect(sent).toEqual([]);
    expect(box.value).toBe('next question');
    await click($('[data-testid="kit-stop"]'));
    expect(stopped).toBe(1);
  });

  it('busy with onSteer: the placeholder invites a steer and Enter steers', async () => {
    const steers: string[] = [];
    await render(h(kit.ChatComposer, { busy: true, onSend() {}, onStop() {}, onSteer: (t: string) => steers.push(t) }));
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    expect(box.placeholder).toBe(kit.DEFAULT_BUSY_PLACEHOLDER);
    await type(box, 'only work notes');
    expect($('[data-testid="kit-send"]')!.getAttribute('aria-label')).toBe('Steer');
    await key(box, 'Enter');
    expect(steers).toEqual(['only work notes']);
    expect(container.textContent).toContain('It applies at the next step');
    expect($('[data-testid="kit-stop"]')).not.toBeNull();
  });

  it('renders the scope, tools and tier slots and the form fallback until the first message', async () => {
    await render(h(kit.ChatComposer, {
      onSend() {}, formFallbackHref: '/new', showFormFallback: true,
      scope: h('span', { id: 'scope-slot' }, 'S'), tools: h('span', { id: 'tools-slot' }, 'T'), tier: h('span', { id: 'tier-slot' }, 'R'),
    }));
    expect($('[data-slot="scope"] #scope-slot')).not.toBeNull();
    expect($('[data-slot="tools"] #tools-slot')).not.toBeNull();
    expect($('[data-slot="tier"] #tier-slot')).not.toBeNull();
    expect($<HTMLAnchorElement>('[data-testid="kit-form-fallback"]')!.textContent).toBe('Fill in a form instead');
    await render(h(kit.ChatComposer, { onSend() {}, formFallbackHref: '/new', showFormFallback: false }));
    expect($('[data-testid="kit-form-fallback"]')).toBeNull();
  });

  it('prefill replaces the draft (a send:false chip)', async () => {
    const ref = { current: null as null | { prefill(t: string): void } };
    await render(h(kit.ChatComposer, { onSend() {}, ref }));
    await act(async () => { ref.current!.prefill('Start something new: '); });
    expect($<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!.value).toBe('Start something new: ');
  });
});

describe('ChatEmpty', () => {
  it('greets by name and hands the chip back', async () => {
    const got: string[] = [];
    await render(h(kit.ChatEmpty, {
      name: 'Sam',
      chips: [{ id: 'needs', label: 'What needs me?', text: 'What needs me?', send: true }, { id: 'new', label: 'Start something new', text: 'Start: ', send: false }],
      onChip: (c: { id: string }) => got.push(c.id),
    }));
    expect($('.kit-greeting')!.textContent).toBe('Hi Sam, what are we working on?');
    await click($('[data-chip="new"]'));
    expect(got).toEqual(['new']);
  });
});

const preview = {
  v: 1 as const, verb: 'Reschedule', target: { kind: 'item', id: 'i1', label: 'Dentist' },
  changes: [{ label: 'Date', before: 'Mon', after: 'Tue' }, { label: 'Note', before: null, after: 'call first' }],
  fingerprint: 'f1',
};
const approvalPart = (over: Record<string, unknown> = {}) => ({
  type: 'tool-reschedule', toolCallId: 'c1', state: 'approval-requested', input: { id: 'i1' },
  approval: { id: 'a1', requestReason: encodeApprovalPreview(preview) }, ...over,
});

describe('ApprovalCard', () => {
  it('shows the server preview as before → after and confirms by approval id', async () => {
    const answers: unknown[] = [];
    await render(h(kit.ApprovalCard, { part: approvalPart() as never, onRespond: (...a: unknown[]) => answers.push(a) }));
    expect($('.kit-card-title')!.textContent).toBe('Reschedule: Dentist');
    expect($$('.kit-change').map(e => e.textContent!.replace(/\s+/g, ' '))).toEqual(['DateMon → becomes Tue', 'Note+ call first']);
    await click($('[data-testid="kit-approval-confirm"]'));
    expect(answers).toEqual([['a1', true, undefined]]);
    expect($('[data-testid="kit-approval"]')!.getAttribute('data-state')).toBe('deciding');
    expect(($('[data-testid="kit-approval-deny"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an admin write needs the name typed', async () => {
    const answers: unknown[] = [];
    const part = approvalPart({ approval: { id: 'a2', requestReason: encodeApprovalPreview({ ...preview, confirmText: 'Dentist' }) } });
    await render(h(kit.ApprovalCard, { part: part as never, onRespond: (...a: unknown[]) => answers.push(a) }));
    const confirm = $<HTMLButtonElement>('[data-testid="kit-approval-confirm"]')!;
    expect(confirm.disabled).toBe(true);
    await type($<HTMLInputElement>('[data-testid="kit-approval-typed"]')!, 'Dentist');
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(answers).toEqual([['a2', true, 'Dentist']]);
  });

  it('folds after the answer: done and discarded', async () => {
    await render(h(kit.ApprovalCard, { part: approvalPart({ state: 'output-available', output: {} }) as never, onRespond() {}, approverName: 'Sam' }));
    expect($('.kit-eyebrow')!.textContent).toBe('Approved by Sam');
    await render(h(kit.ApprovalCard, { part: approvalPart({ state: 'output-denied' }) as never, onRespond() {} }));
    expect($('[data-testid="kit-approval"]')!.getAttribute('data-state')).toBe('denied');
    expect(container.textContent).toContain('Nothing changed.');
  });
});

describe('ChatThread', () => {
  const step = (id: string, label: string, state: string) => ({ type: 'data-step', id, data: { id, label, state } });
  const messages = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Plan the trip' }] },
    {
      id: 'a1', role: 'assistant', parts: [
        step('r1', 'Checked the calendar', 'done'),
        { type: 'tool-search', toolCallId: 'r1', state: 'output-available', input: {}, output: { data: [], objects: [], summary: '3 events' } },
        { type: 'tool-hand_off', toolCallId: 'h1', state: 'output-available', input: {}, output: { data: {}, objects: [] }, approval: { id: 'ap', approved: true } },
        { type: 'data-handoff', id: 't9', data: { taskId: 't9', url: 'https://x/t9', state: 'filed', title: 'Trip plan' } },
        { type: 'text', text: 'Filed it.' },
      ],
    },
    {
      id: 'e1', role: 'event', parts: [
        { type: 'data-handoff', id: 't9', data: { taskId: 't9', url: 'https://x/t9', state: 'completed', summary: 'Itinerary ready' } },
        { type: 'data-event', data: { event: 'handoff.completed', objects: [], text: 'Trip plan finished' } },
      ],
    },
  ];

  it('renders text, tool rows by step label, the hand-off at its newest state, and events', async () => {
    await render(h(kit.ChatThread, { messages, status: 'ready' }));
    const log = $('[data-testid="kit-thread"]')!;
    expect(log.getAttribute('role')).toBe('log');
    expect($('[data-role="user"]')!.textContent).toBe('Plan the trip');
    expect($('[data-tool-call-id="r1"]')!.textContent).toContain('Checked the calendar');
    expect($('[data-tool-call-id="r1"]')!.textContent).toContain('3 events');
    const card = $('[data-testid="kit-handoff"]')!;
    expect(card.getAttribute('data-handoff-state')).toBe('completed');
    expect(card.textContent).toContain('Trip plan');
    expect(card.textContent).toContain('Itinerary ready');
    expect($<HTMLAnchorElement>('[data-testid="kit-handoff"] a')!.href).toBe('https://x/t9');
    expect($('[data-role="event"]')!.textContent).toBe('Trip plan finished');
    // Done turns fold their checklist.
    expect(($('[data-testid="kit-thinking"]') as HTMLDetailsElement).open).toBe(false);
  });

  it('while streaming: the checklist is open with one active step and a tail', async () => {
    const live = [messages[0], { id: 'a2', role: 'assistant', parts: [step('r1', 'Checking the calendar', 'active')] }];
    await render(h(kit.ChatThread, { messages: live, status: 'streaming' }));
    const panel = $('[data-testid="kit-thinking"]') as HTMLDetailsElement;
    expect(panel.open).toBe(true);
    expect($$('.kit-step').map(s => [s.textContent, s.getAttribute('data-state')])).toEqual([['Checking the calendar(in progress)', 'active']]);
  });

  it('renders a turn error in place and does not repeat the request error under it', async () => {
    const message = 'The AI provider refused this turn: the key is out of credit or over its spending limit.';
    const msgs = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a', role: 'assistant', parts: [{ type: 'data-turn-error', id: 'turn-error', data: { code: 'insufficient_credit', message, status: 402 } }] },
    ];
    await render(h(kit.ChatThread, { messages: msgs, status: 'error', error: message }));
    const alerts = $$('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].getAttribute('data-turn-error')).toBe('insufficient_credit');
    expect(alerts[0].textContent).toBe(message);
  });

  it('shows the empty state with no messages', async () => {
    await render(h(kit.ChatThread, { messages: [], empty: h(kit.ChatEmpty, { name: 'Sam', chips: [], onChip() {} }) }));
    expect($('[data-testid="kit-empty"]')).not.toBeNull();
  });
});

describe('ChatSetupCard', () => {
  it('shows the refusal and the app action', async () => {
    await render(h(kit.ChatSetupCard, { reason: 'no_key', message: 'Add your OpenRouter key, or ask Alex.', action: h('a', { href: '/settings/ai' }, 'Add a key') }));
    expect($('[data-testid="kit-setup"]')!.textContent).toContain('Chat needs a key');
    expect($('[data-testid="kit-setup"] a')!.getAttribute('href')).toBe('/settings/ai');
  });
});

describe('useComposerState (shared new-chat composer)', () => {
  it('two composers share one draft, scope and tier; the page scope wins until the person picks; unknown scopes read as all', async () => {
    const saves: unknown[] = [];
    const store = kit.createComposerStore({ prefs: { load: () => ({ scope: 'gone', tier: 'premium' }), save: (_k: string, p: unknown) => { saves.push(p); } } });
    const scopes = [{ id: 'w1', name: 'home' }, { id: 'w2', name: 'work' }];
    function Box({ id, pageScope }: { id: string; pageScope?: string | null }) {
      const c = kit.useComposerState(store, 'team-1', { scopes, pageScope });
      return h('div', { id },
        h(kit.ChatComposer, { value: c.draft, onChange: c.setDraft, onSend() {},
          scope: h(kit.ScopePicker, { options: scopes, value: c.scope, onChange: c.setScope }),
          tier: h(kit.TierPicker, { value: c.tier, onChange: c.setTier }) }),
        h('span', { className: 'scope' }, String(c.scope)), h('span', { className: 'tier' }, String(c.tier)));
    }
    await render(h('div', null, h(Box, { id: 'home' }), h(Box, { id: 'canvas', pageScope: 'w2' })));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    // The remembered scope isn't one of these: all. The canvas's own scope wins there.
    expect($('#home .scope')!.textContent).toBe('null');
    expect($('#canvas .scope')!.textContent).toBe('w2');
    expect($('#home .tier')!.textContent).toBe('premium');
    await type($<HTMLTextAreaElement>('#home [data-testid="kit-composer-input"]')!, 'ship it');
    expect($<HTMLTextAreaElement>('#canvas [data-testid="kit-composer-input"]')!.value).toBe('ship it');
    await click($('#home [data-testid="kit-scope-trigger"]'));
    await click([...$$('#home [role="radio"]')].find(b => b.textContent === 'home')!);
    expect($('#home .scope')!.textContent).toBe('w1');
    expect(saves).toEqual([{ scope: 'w1' }]);
  });
});

// ── 0.6.1: menu placement and sheet close, tier footer and Auto line, setup title ──

const phone = () => {
  const real = window.matchMedia;
  (window as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: q.includes('max-width: 639px'), media: q, addEventListener() {}, removeEventListener() {} });
  return () => { (window as { matchMedia: unknown }).matchMedia = real; };
};

describe('Menu placement (0.6.1)', () => {
  it('opens up by default, down when asked', async () => {
    await render(h(kit.Menu, { label: 'M', trigger: 'm', testId: 'm' }, 'x'));
    await click($('[data-testid="m-trigger"]'));
    expect($('[data-testid="m"]')!.dataset.placement).toBe('up');
    await render(h(kit.Menu, { label: 'N', trigger: 'n', testId: 'n', placement: 'down' }, 'x'));
    await click($('[data-testid="n-trigger"]'));
    expect($('[data-testid="n"]')!.dataset.placement).toBe('down');
  });

  it('auto: down with room below, up at the bottom of the screen', () => {
    expect(kit.menuDropSide({ top: 800, bottom: 848 }, 900)).toBe('up');
    expect(kit.menuDropSide({ top: 120, bottom: 168 }, 900)).toBe('down');
    expect(kit.menuDropSide({ top: 100, bottom: 700 }, 900)).toBe('down');
  });

  it('auto measures the trigger when it opens', async () => {
    await render(h(kit.Menu, { label: 'A', trigger: 'a', testId: 'a', placement: 'auto' }, 'x'));
    // happy-dom lays nothing out: a zero rect near the top has room below.
    await click($('[data-testid="a-trigger"]'));
    expect($('[data-testid="a"]')!.dataset.placement).toBe('down');
  });
});

describe('Menu fits the viewport (0.9.1)', () => {
  it('fitMenuPanel: keeps the preferred side when it fits, flips when only the other fits, else takes the roomier side', () => {
    // A composer near the top (Cue's Home): 180px panel, trigger at 183–231 in a 720px window.
    expect(kit.fitMenuPanel({ top: 183, bottom: 231 }, 180, 720, 'up')).toEqual({ side: 'down', room: 720 - 231 - 6 - 12 });
    // Near the bottom: up fits, stays up.
    expect(kit.fitMenuPanel({ top: 600, bottom: 648 }, 180, 720, 'up')).toEqual({ side: 'up', room: 600 - 6 - 12 });
    // Fits neither: the roomier side, capped to its room.
    expect(kit.fitMenuPanel({ top: 300, bottom: 348 }, 600, 720, 'up')).toEqual({ side: 'down', room: 720 - 348 - 18 });
    expect(kit.fitMenuPanel({ top: 400, bottom: 448 }, 600, 720, 'down')).toEqual({ side: 'up', room: 400 - 18 });
    // Down preferred and fits: stays down.
    expect(kit.fitMenuPanel({ top: 100, bottom: 148 }, 180, 720, 'down').side).toBe('down');
  });

  it('menuShift nudges a panel off either edge', () => {
    expect(kit.menuShift({ left: 100, right: 400 }, 1280)).toBe(0);
    expect(kit.menuShift({ left: 1000, right: 1300 }, 1280)).toBe(1280 - kit.MENU_EDGE - 1300);
    expect(kit.menuShift({ left: -20, right: 280 }, 1280)).toBe(kit.MENU_EDGE + 20);
  });

  it('flips the tier picker down and caps its height when the composer is near the top', async () => {
    const proto = HTMLElement.prototype;
    const realRect = proto.getBoundingClientRect;
    const realScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
    const realH = window.innerHeight;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const r = this.classList.contains('kit-menu')
        ? { top: 183, bottom: 231, left: 715, right: 823 }
        : { top: 0, bottom: 0, left: 563, right: 823 };
      return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON() {} } as DOMRect;
    };
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get() { return this.classList?.contains('kit-menu-panel') ? 400 : 0; } });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 560 });
    try {
      await render(h(kit.TierPicker, { value: null, onChange() {}, options: [{ tier: 'budget' }, { tier: 'standard' }, { tier: 'premium' }], title: 'Model quality' }));
      await click($('[data-testid="kit-tier-trigger"]'));
      expect($('[data-testid="kit-tier"]')!.dataset.placement).toBe('down');
      // Too tall for either side: capped to the room below (560 − 231 − 6 − 12).
      expect($('[data-testid="kit-tier-panel"]')!.style.getPropertyValue('--kit-menu-room')).toBe('311px');
      expect($('[data-testid="kit-tier-panel"]')!.style.getPropertyValue('--kit-menu-shift')).toBe('');
    } finally {
      proto.getBoundingClientRect = realRect;
      if (realScroll) Object.defineProperty(Element.prototype, 'scrollHeight', realScroll);
      else delete (Element.prototype as { scrollHeight?: number }).scrollHeight;
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: realH });
    }
  });

  it('leaves the phone sheet alone', async () => {
    const restore = phone();
    try {
      await render(h(kit.ToolsMenu, { rows, onChange() {} }));
      await click($('[data-testid="kit-tools-trigger"]'));
      const p = document.querySelector<HTMLElement>('[data-testid="kit-tools-panel"]')!;
      expect(p.dataset.sheet).toBe('true');
      expect($('[data-testid="kit-tools"]')!.dataset.placement).toBe('up');
      expect(p.style.getPropertyValue('--kit-menu-room')).toBe('');
      expect(p.style.getPropertyValue('--kit-menu-shift')).toBe('');
    } finally { restore(); }
  });
});

describe('Menu sheet close (0.6.1)', () => {
  it('off by default: the phone sheet has no close button', async () => {
    const restore = phone();
    try {
      await render(h(kit.ToolsMenu, { rows, onChange() {} }));
      await click($('[data-testid="kit-tools-trigger"]'));
      expect(document.querySelector('[data-testid="kit-tools-close"]')).toBeNull();
      expect(document.querySelector('[data-testid="kit-tools-panel"] .kit-menu-title')?.textContent).toBe('Tools');
    } finally { restore(); }
  });

  it('sheetClose: a × beside the title closes the sheet', async () => {
    const restore = phone();
    try {
      await render(h(kit.ToolsMenu, { rows, onChange() {}, sheetClose: true }));
      await click($('[data-testid="kit-tools-trigger"]'));
      const close = document.querySelector<HTMLButtonElement>('[data-testid="kit-tools-close"]')!;
      expect(close.getAttribute('aria-label')).toBe('Close');
      expect(close.closest('.kit-sheet-head')?.querySelector('.kit-menu-title')?.textContent).toBe('Tools');
      await click(close);
      expect(document.querySelector('[data-testid="kit-tools-sheet"]')).toBeNull();
    } finally { restore(); }
  });

  it('sheetClose does nothing to the wide-screen popover', async () => {
    await render(h(kit.ToolsMenu, { rows, onChange() {}, sheetClose: true }));
    await click($('[data-testid="kit-tools-trigger"]'));
    expect($('[data-testid="kit-tools-panel"]')).not.toBeNull();
    expect($('[data-testid="kit-tools-close"]')).toBeNull();
  });
});

describe('TierPicker footer and Auto line (0.6.1)', () => {
  it('shows the footer under the options and the app\'s Auto line', async () => {
    await render(h(kit.TierPicker, { value: null, onChange() {}, autoMeta: 'Routed per message', footer: 'This chat: $0.04' }));
    await click($('[data-testid="kit-tier-trigger"]'));
    const panel = $('[data-testid="kit-tier-panel"]')!;
    expect(panel.querySelector('[role="radio"] .kit-option-meta')!.textContent).toBe('Routed per message');
    const footer = panel.querySelector('[data-testid="kit-tier-footer"]')!;
    expect(footer.textContent).toBe('This chat: $0.04');
    expect(footer.previousElementSibling?.getAttribute('role')).toBe('radiogroup');
  });

  it('without them: "picks per turn" and no footer, as before', async () => {
    await render(h(kit.TierPicker, { value: null, onChange() {} }));
    await click($('[data-testid="kit-tier-trigger"]'));
    expect($('[data-testid="kit-tier-panel"] [role="radio"] .kit-option-meta')!.textContent).toBe('picks per turn');
    expect($('[data-testid="kit-tier-footer"]')).toBeNull();
  });
});

describe('ChatSetupCard title (0.6.1)', () => {
  it('is a heading between the eyebrow and the message', async () => {
    await render(h(kit.ChatSetupCard, { reason: 'no_key', title: 'Connect a model provider', message: 'It starts once the team has a key.' }));
    const t = $('[data-testid="kit-setup-title"]')!;
    expect(t.tagName).toBe('H3');
    expect(t.textContent).toBe('Connect a model provider');
    expect(t.previousElementSibling?.className).toBe('kit-eyebrow');
    expect(t.nextElementSibling?.textContent).toBe('It starts once the team has a key.');
  });

  it('no title: no heading', async () => {
    await render(h(kit.ChatSetupCard, { reason: 'no_key', message: 'm' }));
    expect($('[data-testid="kit-setup-title"]')).toBeNull();
  });
});
