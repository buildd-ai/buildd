/**
 * The `/chat/react` components, mounted (happy-dom). Runs in its own process
 * (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/chat' });

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';

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

  it('maxLength: a count near the cap, and past it Send does nothing and the draft stays', async () => {
    const sent: string[] = [];
    await render(h(kit.ChatComposer, { onSend: (t: string) => sent.push(t), maxLength: 100 }));
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    await type(box, 'x'.repeat(89));
    expect($('[data-testid="kit-composer-count"]')).toBeNull();
    await type(box, 'x'.repeat(90));
    expect($('[data-testid="kit-composer-count"]')!.textContent).toBe('90 / 100 characters');
    await type(box, 'x'.repeat(101));
    expect($('[data-testid="kit-composer-count"]')!.hasAttribute('data-over')).toBe(true);
    expect($('[data-testid="kit-send"]')!.getAttribute('aria-disabled')).toBe('true');
    await key(box, 'Enter');
    expect(sent).toEqual([]);
    expect(box.value).toBe('x'.repeat(101));
    await type(box, 'x'.repeat(100));
    await key(box, 'Enter');
    expect(sent).toEqual(['x'.repeat(100)]);
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

const paste = async (el: Element, text: string) => {
  let prevented = false;
  await act(async () => {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : '') } });
    el.dispatchEvent(ev);
    prevented = ev.defaultPrevented;
  });
  return prevented;
};

describe('ChatComposer attachments (0.25.0)', () => {
  type Sent = { text: string; attachments: Array<{ id: string; title: string; text: string }> };

  it('a paste over attachFrom becomes a card, not text; a shorter one stays in the box', async () => {
    const sent: Sent[] = [];
    await render(h(kit.ChatComposer, { onSend: (text: string, attachments: Sent['attachments']) => sent.push({ text, attachments }), attachFrom: 8000 }));
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    expect(await paste(box, 'x'.repeat(8000))).toBe(false); // at the threshold: the browser inserts it
    expect($('[data-testid="kit-attachment"]')).toBeNull();
    const long = `Quarterly report\n${'y'.repeat(60_000)}`;
    expect(await paste(box, long)).toBe(true);
    expect($$('[data-testid="kit-attachment"]')).toHaveLength(1);
    expect($('[data-testid="kit-attachment-title"]')!.textContent).toBe('Quarterly report');
    expect(container.textContent).toContain(`${long.length.toLocaleString('en-US')} characters`);
    expect(box.value).toBe('');
    // An attachment alone can be sent; the text is exact, byte for byte.
    expect($('[data-testid="kit-send"]')!.getAttribute('aria-disabled')).toBeNull();
    await key(box, 'Enter');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('');
    expect(sent[0].attachments[0].text).toBe(long);
    expect(sent[0].attachments[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect($('[data-testid="kit-attachment"]')).toBeNull();
  });

  it('Remove takes the card out of the draft', async () => {
    const sent: Sent[] = [];
    await render(h(kit.ChatComposer, { onSend: (text: string, attachments: Sent['attachments']) => sent.push({ text, attachments }), attachFrom: 10 }));
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    await paste(box, 'a long paste here');
    await type(box, 'summarize');
    await click($('[data-testid="kit-attachment-remove"]'));
    expect($('[data-testid="kit-attachment"]')).toBeNull();
    await key(box, 'Enter');
    expect(sent).toEqual([{ text: 'summarize', attachments: [] }]);
  });

  it('maxLength counts the text and the attachments together', async () => {
    const sent: Sent[] = [];
    await render(h(kit.ChatComposer, { onSend: (text: string, attachments: Sent['attachments']) => sent.push({ text, attachments }), attachFrom: 10, maxLength: 100 }));
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    await paste(box, 'z'.repeat(95));
    await type(box, 'x'.repeat(6));
    expect($('[data-testid="kit-composer-count"]')!.textContent).toContain('101 / 100 characters');
    await key(box, 'Enter');
    expect(sent).toEqual([]);
    expect($('[data-testid="kit-attachment"]')).not.toBeNull();
  });

  it('controlled attachments survive a refused send: the app puts them back', async () => {
    let attachments = [{ id: '11111111-1111-4111-8111-111111111111', title: 'Pasted', text: 'q'.repeat(9000) }];
    const sent: Sent[] = [];
    const view = () => h(kit.ChatComposer, {
      attachFrom: 8000, attachments,
      onAttachmentsChange: (a: Sent['attachments']) => { attachments = a; },
      onSend: (text: string, a: Sent['attachments']) => sent.push({ text, attachments: a }),
    });
    await render(view());
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    await key(box, 'Enter');
    expect(sent[0].attachments[0].id).toBe('11111111-1111-4111-8111-111111111111');
    expect(attachments).toEqual([]);
    // The send was refused: the app restores the same draft, same id.
    attachments = sent[0].attachments;
    await render(view());
    expect($$('[data-testid="kit-attachment"]')).toHaveLength(1);
    await key(box, 'Enter');
    expect(sent[1].attachments[0].id).toBe(sent[0].attachments[0].id);
  });

  it('busy with onSteer: a draft holding an attachment does not steer', async () => {
    const steers: string[] = [];
    await render(h(kit.ChatComposer, {
      busy: true, onSend() {}, onStop() {}, onSteer: (t: string) => steers.push(t), attachFrom: 10,
      attachments: [{ id: '22222222-2222-4222-8222-222222222222', title: 'P', text: 'long enough text' }],
    }));
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    await type(box, 'also this');
    await key(box, 'Enter');
    expect(steers).toEqual([]);
  });
});

describe('ChatThread attachments (0.25.0)', () => {
  it('a message carrying an attachment shows a fixed card that opens the reader; the text stays out of the thread', async () => {
    const opened: string[] = [];
    const ref = { artifactId: '33333333-3333-4333-8333-333333333333', revision: 1, sha256: 'a'.repeat(64), chars: 60_000, title: 'Logs' };
    await render(h(kit.ChatThread, {
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'what failed?' }, { type: 'data-attachment', data: ref }] }],
      onOpenAttachment: (d: typeof ref) => opened.push(d.artifactId),
    }));
    expect($('[data-testid="kit-attachment-title"]')!.textContent).toBe('Logs');
    expect(container.textContent).toContain('60,000 characters');
    await click($('[data-testid="kit-attachment-open"]'));
    expect(opened).toEqual([ref.artifactId]);
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

  it('while streaming: one live line with the active step, nothing else', async () => {
    const live = [messages[0], { id: 'a2', role: 'assistant', parts: [step('r1', 'Checking the calendar', 'active')] }];
    await render(h(kit.ChatThread, { messages: live, status: 'streaming', thinkingName: 'Trips is working' }));
    const line = $('[data-testid="kit-thinking-live"]')!;
    expect(line.getAttribute('aria-label')).toBe('Trips is working: Checking the calendar');
    expect(line.querySelector('.kit-live-label')!.textContent).toBe('Checking the calendar');
    expect($('summary')).toBeNull();
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

describe('ThinkingPanel (0.17.0: one live line)', () => {
  type S = { id: string; label: string; state: 'done' | 'active' | 'pending'; weight?: 'key' | 'routine' };
  const r = (id: string, label = id, state: S['state'] = 'done'): S => ({ id, label, state, weight: 'routine' });
  const k = (id: string, label = id, state: S['state'] = 'done'): S => ({ id, label, state, weight: 'key' });
  const panel = (steps: S[], extra: Record<string, unknown> = {}) => h(kit.ThinkingPanel, { steps, streaming: true, name: 'Buildd is working', ...extra });
  const live = () => $('[data-testid="kit-thinking-live"]');
  const pinned = () => $('[data-testid="kit-thinking-pinned"]');
  const visibleText = () => $('[data-testid="kit-thinking"]')!.textContent;

  it('collapsed: the square and the active label only; no header, no list, no count', async () => {
    await render(panel([r('a', 'Read a task'), r('b', 'Looked over the tasks'), r('c', 'Reading a mission', 'active')]));
    expect(live()!.tagName).toBe('BUTTON');
    expect(live()!.getAttribute('aria-expanded')).toBe('false');
    expect(live()!.querySelector('.kit-step-mark')).not.toBeNull();
    expect(live()!.querySelector('.kit-live-label')!.getAttribute('aria-live')).toBe('polite');
    expect(visibleText()).toBe('Reading a mission›');
    expect($('summary')).toBeNull();
    expect($('.kit-steps')).toBeNull();
  });

  it('the label swaps in place as the step changes', async () => {
    await render(panel([r('a', 'Reading a task', 'active')]));
    const before = live();
    await render(panel([r('a', 'Read a task'), r('b', 'Checking the change', 'active')]));
    expect(live()).toBe(before);
    expect(live()!.querySelector('.kit-live-label')!.textContent).toBe('Checking the change');
  });

  it('before the first step: the square alone, no text', async () => {
    await render(panel([]));
    expect(live()!.querySelector('.kit-step-mark')).not.toBeNull();
    expect(live()!.getAttribute('aria-label')).toBe('Buildd is working');
    expect(visibleText()).toBe('');
    await render(panel(kit.thinkingSteps([], true) as S[]));
    expect(visibleText()).toBe('');
    expect(live()!.tagName).not.toBe('BUTTON');
  });

  it('once the answer streams and no step is active, the square goes', async () => {
    const steps = kit.thinkingSteps([
      { type: 'data-step', id: 'a', data: { id: 'a', label: 'Read a task', state: 'done', weight: 'routine' } },
      { type: 'text', text: 'So' },
    ] as never, true) as S[];
    await render(panel(steps));
    expect(live()).toBeNull();
  });

  it('a completed write pins under the line, and the next write replaces it; reads never pin', async () => {
    await render(panel([r('a', 'Read a task'), r('b', 'Reading a mission', 'active')]));
    expect(pinned()).toBeNull();
    await render(panel([r('a'), k('w1', 'Drafted a task'), r('b'), r('c', 'Reading', 'active')]));
    expect(pinned()!.textContent).toContain('Drafted a task');
    await render(panel([r('a'), k('w1', 'Drafted a task'), r('b'), k('w2', 'Drafted a mission'), r('c'), r('d', 'Reading', 'active')]));
    expect($$('[data-testid="kit-thinking-pinned"]')).toHaveLength(1);
    expect(pinned()!.textContent).toContain('Drafted a mission');
    expect(pinned()!.textContent).not.toContain('Drafted a task');
  });

  it('renderPinned draws the pinned step its own way (a write as its object)', async () => {
    await render(panel([k('w1', 'Drafted a task'), r('b', 'Reading', 'active')], {
      renderPinned: (s: S) => h('div', { className: 'card' }, `card for ${s.id}`),
    }));
    expect(pinned()!.querySelector('.card')!.textContent).toBe('card for w1');
  });

  it('the live step shows its seconds only once it has run 20s', async () => {
    const t0 = Date.now();
    try {
      setSystemTime(new Date(t0));
      await render(panel([r('a', 'Reading the run logs', 'active')]));
      setSystemTime(new Date(t0 + 19_000));
      await render(panel([r('a', 'Reading the run logs', 'active')]));
      expect($('[data-testid="kit-thinking-timer"]')).toBeNull();
      setSystemTime(new Date(t0 + 23_000));
      await render(panel([r('a', 'Reading the run logs', 'active')]));
      expect($('[data-testid="kit-thinking-timer"]')!.textContent).toBe('23s');
      // A new step starts its own clock.
      await render(panel([r('a', 'Read the run logs'), r('b', 'Reading a task', 'active')]));
      expect($('[data-testid="kit-thinking-timer"]')).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  it('tap expands the turn: key rows in order, routine runs folded, the live step last; tap again collapses', async () => {
    const steps = [r('a', 'Read a task'), r('b', 'Looked over the tasks'), r('c', 'Searched'), k('w1', 'Drafted a task'),
      k('f1', "Couldn't open the task"), r('d', 'Read a mission'), k('p1', 'Check it with you', 'pending'), r('e', 'Read 2 tasks'), r('f', 'Checked the budget'), r('g', 'Reading the errors', 'active')];
    await render(panel(steps));
    await click(live());
    expect(live()!.getAttribute('aria-expanded')).toBe('true');
    expect(pinned()).toBeNull();
    const rows = $$('[data-testid="kit-thinking"] > .kit-steps > li');
    expect(rows.map(li => (li.classList.contains('kit-step-fold') ? `fold:${li.querySelector('.kit-step-fold-count')!.textContent}` : li.querySelector('.kit-step-mark + span')!.textContent))).toEqual([
      'fold:3 routine steps', 'Drafted a task', "Couldn't open the task", 'Read a mission', 'Check it with you', 'fold:2 routine steps', 'Reading the errors',
    ]);
    expect(rows[1].getAttribute('data-weight')).toBe('key');
    expect(rows.at(-1)!.getAttribute('data-state')).toBe('active');
    expect(rows[0].querySelector('.kit-step-fold-labels')!.textContent).toBe('Read a task · Looked over the tasks · Searched');
    // Unfold a routine run in place.
    const fold = rows[0].querySelector('button')!;
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    await click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect([...rows[0].querySelectorAll('.kit-step')].map(li => li.querySelector('.kit-step-mark + span')!.textContent)).toEqual(['Read a task', 'Looked over the tasks', 'Searched']);
    await click(fold);
    expect(rows[0].querySelector('.kit-step')).toBeNull();
    await click(live());
    expect(live()!.getAttribute('aria-expanded')).toBe('false');
    expect($('.kit-steps > .kit-step-fold')).toBeNull();
  });

  it('steps without a weight: only the waiting one is key', async () => {
    await render(panel([{ id: 'a', label: 'Read a task', state: 'done' }, { id: 'b', label: 'Read a task', state: 'done' }, { id: 'p', label: 'Check it', state: 'pending' }, { id: 'c', label: 'Reading', state: 'active' }]));
    expect(pinned()!.textContent).toContain('Check it');
    await click(live());
    expect($$('[data-testid="kit-thinking"] > .kit-steps > li').map(li => li.className)).toEqual(['kit-step-fold', 'kit-step', 'kit-step']);
  });

  it('a done turn folds to its summary and unfolds into the same filtered list', async () => {
    const steps = [r('a', 'Read a task'), r('b', 'Read a mission'), k('w1', 'Drafted a task')];
    await render(h(kit.ThinkingPanel, { steps, streaming: false, summary: 'Did 3 steps · filed 1 task', open: true }));
    expect($('[data-testid="kit-thinking-summary"]')!.textContent).toBe('Did 3 steps · filed 1 task');
    expect($$('.kit-steps > li').map(li => li.className)).toEqual(['kit-step-fold', 'kit-step']);
    expect(live()).toBeNull();
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

describe('ChatComposer files (0.26.0)', () => {
  type Sent = { text: string; attachments: Array<Record<string, unknown>> };
  const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type });
  const deferred = <T,>() => {
    let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const pick = async (files: File[]) => {
    const input = $<HTMLInputElement>('[data-testid="kit-attach-input"]')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  };
  const ready = (id: string, f: File) => ({ kind: 'file' as const, id, name: f.name, mediaType: f.type, sizeBytes: f.size });

  it('no upload handler, no Attach button: the composer takes no files', async () => {
    await render(h(kit.ChatComposer, { onSend: () => {} }));
    expect($('[data-testid="kit-attach"]')).toBeNull();
  });

  it('uploading never reads as attached and holds Send; once ready it is sent by id', async () => {
    const sent: Sent[] = [];
    const up = deferred<ReturnType<typeof ready>>();
    await render(h(kit.ChatComposer, { onSend: (text: string, attachments: Sent['attachments']) => sent.push({ text, attachments }), onUploadFile: () => up.promise }));
    const pdf = file('Q3 report.pdf', 'application/pdf');
    await pick([pdf]);
    const card = $('[data-testid="kit-file"]')!;
    expect(card.getAttribute('data-state')).toBe('uploading');
    expect($('[data-testid="kit-file-state"]')!.textContent).toBe('Uploading…');
    expect($('[data-testid="kit-attachment-open"]')).toBeNull();
    expect($('[data-testid="kit-send"]')!.getAttribute('aria-disabled')).toBe('true');
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    await type(box, 'summarize');
    await key(box, 'Enter');
    expect(sent).toEqual([]);

    await act(async () => { up.resolve(ready('11111111-1111-4111-8111-111111111111', pdf)); await up.promise; });
    expect($('[data-testid="kit-file"]')!.getAttribute('data-state')).toBe('ready');
    expect($('[data-testid="kit-file-state"]')!.textContent).toContain('PDF ·');
    await key(box, 'Enter');
    expect(sent).toEqual([{ text: 'summarize', attachments: [ready('11111111-1111-4111-8111-111111111111', pdf)] }]);
  });

  it('a failed upload says so, holds Send, and Retry runs it again', async () => {
    const attempts: Array<ReturnType<typeof deferred<ReturnType<typeof ready>>>> = [];
    const sent: Sent[] = [];
    await render(h(kit.ChatComposer, {
      onSend: (text: string, attachments: Sent['attachments']) => sent.push({ text, attachments }),
      onUploadFile: () => { const d = deferred<ReturnType<typeof ready>>(); attempts.push(d); return d.promise; },
    }));
    const png = file('chart.png', 'image/png');
    await pick([png]);
    await act(async () => { attempts[0]!.reject(new Error('Upload check failed')); await attempts[0]!.promise.catch(() => {}); });
    expect($('[data-testid="kit-file"]')!.getAttribute('data-state')).toBe('failed');
    expect($('[data-testid="kit-file-state"]')!.textContent).toBe('Upload check failed');
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    await type(box, 'look');
    await key(box, 'Enter');
    expect(sent).toEqual([]);
    await click($('[data-testid="kit-file-retry"]'));
    expect(attempts).toHaveLength(2);
    expect($('[data-testid="kit-file"]')!.getAttribute('data-state')).toBe('uploading');
    await act(async () => { attempts[1]!.resolve(ready('22222222-2222-4222-8222-222222222222', png)); await attempts[1]!.promise; });
    await key(box, 'Enter');
    expect(sent).toHaveLength(1);
  });

  it('Remove while uploading cancels it: aborted, never attached, never sent', async () => {
    let signal: AbortSignal | null = null;
    const up = deferred<ReturnType<typeof ready>>();
    const sent: Sent[] = [];
    await render(h(kit.ChatComposer, {
      onSend: (text: string, attachments: Sent['attachments']) => sent.push({ text, attachments }),
      onUploadFile: (_f: File, s: AbortSignal) => { signal = s; return up.promise; },
    }));
    const png = file('chart.png', 'image/png');
    await pick([png]);
    await click($('[data-testid="kit-attachment-remove"]'));
    expect(signal!.aborted).toBe(true);
    expect($('[data-testid="kit-file"]')).toBeNull();
    // The upload finishing after the cancel changes nothing.
    await act(async () => { up.resolve(ready('33333333-3333-4333-8333-333333333333', png)); await up.promise; });
    expect($('[data-testid="kit-file"]')).toBeNull();
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    await type(box, 'hi');
    await key(box, 'Enter');
    expect(sent).toEqual([{ text: 'hi', attachments: [] }]);
  });

  it('Remove of a ready, unsent file hands it back to discard', async () => {
    const discarded: string[] = [];
    const png = file('chart.png', 'image/png');
    await render(h(kit.ChatComposer, {
      onSend: () => {},
      onUploadFile: async () => ready('44444444-4444-4444-8444-444444444444', png),
      onDiscardFile: (f: { id: string }) => discarded.push(f.id),
    }));
    await pick([png]);
    await click($('[data-testid="kit-attachment-remove"]'));
    expect(discarded).toEqual(['44444444-4444-4444-8444-444444444444']);
  });

  it('a type outside the list, or a file over the cap, fails at once with no upload and no Retry', async () => {
    let uploads = 0;
    await render(h(kit.ChatComposer, { onSend: () => {}, onUploadFile: async () => { uploads++; throw new Error('x'); }, maxFileBytes: 100 }));
    await pick([file('run.exe', 'application/x-msdownload'), file('big.png', 'image/png', 101)]);
    expect(uploads).toBe(0);
    const states = $$('[data-testid="kit-file-state"]').map(e => e.textContent);
    expect(states).toEqual(['File type not supported', 'Over 100 bytes']);
    expect($('[data-testid="kit-file-retry"]')).toBeNull();
  });

  it('a pasted image goes up as a file, not text', async () => {
    const uploaded: File[] = [];
    await render(h(kit.ChatComposer, { onSend: () => {}, onUploadFile: async (f: File) => { uploaded.push(f); return ready('55555555-5555-4555-8555-555555555555', f); } }));
    const box = $<HTMLTextAreaElement>('[data-testid="kit-composer-input"]')!;
    const img = file('image.png', 'image/png');
    await act(async () => {
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: { files: [img], getData: () => '' } });
      box.dispatchEvent(ev);
    });
    expect(uploaded).toEqual([img]);
  });

  it('a long file name truncates inside the card instead of widening it', async () => {
    const name = `${'quarterly-revenue-by-region-'.repeat(8)}final.png`;
    await render(h(kit.FileCard, { name, mediaType: 'image/png', sizeBytes: 482_113 }));
    const title = $('[data-testid="kit-attachment-title"]')!;
    expect(title.className).toBe('kit-attachment-title');
    // The truncation chain: every flex box between the card and the title can shrink.
    expect(title.parentElement!.className).toBe('kit-attachment-text');
    expect($('[data-testid="kit-file"]')!.className).toContain('kit-attachment');
    expect(container.textContent).toContain('PNG · 471 KB');
  });

  it('a stored file in a message renders as a card that opens it, with its thumbnail', async () => {
    const opened: string[] = [];
    const msg = { id: 'm1', role: 'user', parts: [{ type: 'data-file', data: { artifactId: 'a1', revision: 1, sha256: 'f'.repeat(64), name: 'chart.png', mediaType: 'image/png', sizeBytes: 10 } }] };
    await render(h(kit.ChatThread, { messages: [msg], status: 'ready', onOpenFile: (d: { artifactId: string }) => opened.push(d.artifactId), fileImageUrl: () => '/thumb/a1' }));
    expect($<HTMLImageElement>('[data-testid="kit-file-thumb"]')!.getAttribute('src')).toBe('/thumb/a1');
    await click($('[data-testid="kit-attachment-open"]'));
    expect(opened).toEqual(['a1']);
  });
});

describe('attachment rows and the Attach button on a phone (0.27.1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /** Every declaration block whose selector list names `selector` exactly. */
  const rulesFor = (selector: string) => [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(m => m[1]!.split(',').map(s => s.trim()).includes(selector))
    .map(m => m[2]!);
  const decl = (selector: string, prop: string) => {
    let v: string | undefined;
    for (const body of rulesFor(selector)) for (const d of body.split(';')) {
      const [k, ...rest] = d.split(':');
      if (k?.trim() === prop) v = rest.join(':').trim();
    }
    return v;
  };

  it('a failed upload shows its whole reason: the detail line wraps and the card grows, never an ellipsis', async () => {
    const reason = 'Upload failed. Check your connection and retry.';
    await render(h(kit.FileCard, { name: 'notes.pdf', mediaType: 'application/pdf', sizeBytes: 10, state: 'failed', error: reason, onRetry: () => {}, onRemove: () => {} }));
    expect($('[data-testid="kit-file-state"]')!.textContent).toBe(reason);
    const failed = '.kit-attachment[data-state="failed"] .kit-attachment-size';
    expect(decl(failed, 'white-space')).toBe('normal');
    expect(decl(failed, 'text-overflow')).not.toBe('ellipsis');
    expect(decl('.kit-attachment[data-state="failed"]', 'height')).toBe('auto');
    expect(decl('.kit-attachment[data-state="failed"]', 'min-height')).toBe('56px');
  });

  it('detail and count lines are prose, not tabular figures: the body font widens "," and "." to a digit under tnum', () => {
    // "60,000 characters" rendered "60 , 000", "1.1 MB" rendered "1 . 1 MB".
    expect(decl('.kit-attachment-size', 'font-variant-numeric')).toBeUndefined();
    expect(decl('.kit-composer-count', 'font-variant-numeric')).toBeUndefined();
  });

  it('the Attach button fills its toolbar cell like Send, at least a 44px target', async () => {
    await render(h(kit.ChatComposer, { onSend: () => {}, onUploadFile: () => new Promise(() => {}) }));
    expect($('[data-testid="kit-attach"]')!.className).toBe('kit-attach');
    expect(decl('.kit-attach', 'height')).toBeUndefined();
    expect(decl('.kit-attach', 'align-self')).toBe('stretch');
    expect(parseInt(decl('.kit-attach', 'min-height') ?? '0', 10)).toBeGreaterThanOrEqual(44);
    expect(parseInt(decl('.kit-attach', 'min-width') ?? '0', 10)).toBeGreaterThanOrEqual(44);
    expect(decl('.kit-attach', 'border')).toBe('0');
  });
});
