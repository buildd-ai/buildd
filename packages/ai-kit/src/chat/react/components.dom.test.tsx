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
  it('shows ··· N for groups on Allow, opens the rows, toggles, and closes on Escape back to the trigger', async () => {
    const changes: string[] = [];
    await render(h(kit.ToolsMenu, { rows, onChange: (k: string, m: string) => changes.push(`${k}:${m}`) }));
    expect($('[data-testid="kit-tools-count"]')!.textContent).toBe('1');
    const trigger = $('[data-testid="kit-tools-trigger"]')!;
    expect(trigger.getAttribute('aria-label')).toBe('Tools, 1 allowed without asking');
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

  it('shows just ··· with nothing on Allow', async () => {
    await render(h(kit.ToolsMenu, { rows: rows.map(r => ({ ...r, mode: r.mode === 'allow' ? 'ask' : r.mode })), onChange() {} }));
    expect($('[data-testid="kit-tools-count"]')).toBeNull();
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
