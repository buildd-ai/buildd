/**
 * 0.8.0: the approval, empty-state, tier and menu slots buildd needed. Every
 * slot is optional, so the first test of each block pins the default markup:
 * an app that passes none of them (Cue, moa) renders exactly as on 0.6.x.
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/chat' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
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
const kids = (el: Element | null) => [...(el?.children ?? [])].map(c => `${c.tagName.toLowerCase()}${c.className ? `.${String(c.className).split(' ').join('.')}` : ''}`);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const preview = {
  v: 1 as const, verb: 'Watch', target: { kind: 'pr', id: 'p1', label: 'PR #7' },
  changes: [{ label: 'When', before: null, after: 'it merges' }, { label: 'Where', before: 'email', after: 'here' }, { label: 'Ends', before: null, after: 'in 7 days' }],
  fingerprint: 'f1',
};
const part = (over: Record<string, unknown> = {}) => ({
  type: 'tool-watch', toolCallId: 'c1', state: 'approval-requested', input: { id: 'p1' },
  approval: { id: 'a1', requestReason: encodeApprovalPreview(preview) }, ...over,
});
const draftPart = (over: Record<string, unknown> = {}) => ({
  type: 'tool-manage_missions', toolCallId: 'c2', state: 'approval-requested', input: { action: 'create', title: 'Invoices' },
  approval: { id: 'a2' }, ...over,
});

describe('ApprovalCard slots (0.8.0)', () => {
  it('defaults are unchanged: eyebrow, title, changes, actions; Confirm / Applying…; a folded card on decide', async () => {
    const answers: unknown[] = [];
    await render(h(kit.ApprovalCard, { part: part(), onRespond: (...a: unknown[]) => answers.push(a) }));
    const card = $('[data-testid="kit-approval"]')!;
    expect(kids(card)).toEqual(['span.kit-eyebrow', 'h3.kit-card-title', 'ul.kit-changes', 'div.kit-actions']);
    expect($('.kit-card-title')!.textContent).toBe('Watch: PR #7');
    expect($$('.kit-change').map(e => e.textContent!.replace(/\s+/g, ' '))).toEqual(['When+ it merges', 'Whereemail → becomes here', 'Ends+ in 7 days']);
    expect($('.kit-fold-toggle')).toBeNull();
    const confirm = $<HTMLButtonElement>('[data-testid="kit-approval-confirm"]')!;
    expect(confirm.textContent).toBe('Confirm');
    await click(confirm);
    expect(confirm.textContent).toBe('Applying…');
    expect(answers).toEqual([['a1', true, undefined]]);

    await render(h(kit.ApprovalCard, { part: part({ state: 'output-denied' }), onRespond() {} }));
    expect(kids($('[data-testid="kit-approval"]'))).toEqual(['span.kit-eyebrow', 'p.kit-card-title', 'p.kit-note']);
    expect($('.kit-note')!.textContent).toBe('Nothing changed.');
    await render(h(kit.ApprovalCard, { part: part({ state: 'output-available', output: {} }), onRespond() {}, approverName: 'Sam' }));
    expect(kids($('[data-testid="kit-approval"]'))).toEqual(['span.kit-eyebrow', 'p.kit-card-title']);
  });

  it('the +/− markers and the arrow carry classes, with the same text', async () => {
    await render(h(kit.ApprovalCard, { part: part(), onRespond() {} }));
    expect($$('.kit-change-mark').map(m => m.textContent)).toEqual(['+', '+']);
    expect($$('.kit-change-mark').every(m => m.dataset.mark === 'add')).toBe(true);
    expect($('.kit-change-arrow')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('headline, eyebrow and meta: a head row for a write without a preview', async () => {
    await render(h(kit.ApprovalCard, { part: draftPart(), onRespond() {}, headline: 'Invoices', eyebrow: 'New mission', meta: 'billing-web' }));
    const head = $('.kit-card-head')!;
    expect(kids(head)).toEqual(['span.kit-eyebrow', 'span.kit-card-tag', 'span.kit-card-meta']);
    expect(head.textContent).toBe('Needs your OKNew missionbilling-web');
    expect($('.kit-card-title')!.textContent).toBe('Invoices');
    expect($('section')!.getAttribute('aria-label')).toBe('Needs your OK: Invoices');
  });

  it('body and details: the app renders the draft; details replace the raw fields', async () => {
    await render(h(kit.ApprovalCard, {
      part: draftPart(), onRespond() {}, headline: 'Invoices',
      body: h('p', { 'data-testid': 'goal' }, 'Bill in their currency.'),
      details: h('dl', { 'data-testid': 'criteria' }, h('dt', null, 'Done when')),
    }));
    expect($('.kit-approval-body [data-testid="goal"]')).not.toBeNull();
    expect($('[data-testid="criteria"]')).not.toBeNull();
    // No raw fields ("Action", "Title") when the app renders its own details.
    expect($('.kit-changes')).toBeNull();
  });

  it('confirmLabel and busyLabel', async () => {
    await render(h(kit.ApprovalCard, { part: draftPart(), onRespond() {}, confirmLabel: 'Confirm & file', busyLabel: 'Filing…' }));
    const confirm = $<HTMLButtonElement>('[data-testid="kit-approval-confirm"]')!;
    expect(confirm.textContent).toBe('Confirm & file');
    await click(confirm);
    expect(confirm.textContent).toBe('Filing…');
  });

  it('fold: "Show details · N changes" toggles the change list (a phone fold, CSS-gated below 640px)', async () => {
    await render(h(kit.ApprovalCard, { part: part(), onRespond() {}, fold: true }));
    const toggle = $<HTMLButtonElement>('[data-testid="kit-approval-fold"]')!;
    const details = $('[data-testid="kit-approval-details"]')!;
    expect(toggle.textContent).toBe('▸Show details3 changes');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(details.id);
    expect(details.querySelectorAll('.kit-change')).toHaveLength(3);
    expect(details.dataset.open).toBeUndefined();
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details.dataset.open).toBe('true');
    expect(toggle.textContent).toContain('Hide details');
  });

  it('fold with app details and a summary', async () => {
    await render(h(kit.ApprovalCard, { part: draftPart(), onRespond() {}, details: h('dl', null), fold: { summary: '4 criteria · plan' } }));
    expect($('[data-testid="kit-approval-fold"]')!.textContent).toBe('▸Show details4 criteria · plan');
    // Nothing to fold: no toggle.
    await render(h(kit.ApprovalCard, { part: part({ approval: { id: 'a1', requestReason: encodeApprovalPreview({ ...preview, changes: [] }) } }), onRespond() {}, fold: true }));
    expect($('[data-testid="kit-approval-fold"]')).toBeNull();
  });

  it('settled="row": a decided or discarded card is one line', async () => {
    await render(h(kit.ApprovalCard, { part: part({ state: 'output-denied' }), onRespond() {}, settled: 'row', headline: 'Tell me when', deniedNote: 'nothing filed' }));
    const row = $('[data-testid="kit-approval"]')!;
    expect(row.classList.contains('kit-approval-row')).toBe(true);
    expect(row.dataset.state).toBe('denied');
    expect(row.textContent).toBe('Tell me whendiscarded · nothing filed');
    await render(h(kit.ApprovalCard, { part: part({ state: 'output-available', output: {} }), onRespond() {}, settled: 'row', approverName: 'Sam' }));
    expect($('[data-testid="kit-approval"]')!.textContent).toBe('Watch: PR #7approved by Sam');
    // Still awaiting: the full card.
    await render(h(kit.ApprovalCard, { part: part(), onRespond() {}, settled: 'row' }));
    expect($('.kit-approval-row')).toBeNull();
    expect($('[data-testid="kit-approval-confirm"]')).not.toBeNull();
  });
});

const chips = [
  { id: 'needs-0', label: 'Answer the waiting question', text: 'Answer', send: false, tone: 'needs' },
  { id: 'row-1', label: 'What is running?', text: 'What is running?', send: true },
];

describe('ChatEmpty slots (0.8.0)', () => {
  it('defaults are unchanged: greeting then chips, no data-tone or variant', async () => {
    await render(h(kit.ChatEmpty, { name: 'Sam', chips: chips.map(({ tone: _t, ...c }) => c), onChip() {} }));
    expect(kids($('[data-testid="kit-empty"]'))).toEqual(['h2.kit-greeting', 'ul.kit-chips']);
    expect($('[data-testid="kit-empty"]')!.dataset.mood).toBeUndefined();
    expect($('.kit-chips')!.dataset.variant).toBeUndefined();
    expect($$('.kit-chip').map(c => c.dataset.tone)).toEqual([undefined, undefined]);
  });

  it('overline with a mood dot, a sub line, and the chips header read before the chips', async () => {
    await render(h(kit.ChatEmpty, {
      chips, onChip() {}, greeting: 'One thing needs you.', overline: 'Mon 28 Sep · Needs you', mood: 'needs',
      sub: 'A question is waiting.', chipsHeader: 'Picked for you', chipsAside: '1 blocked', variant: 'rows',
    }));
    const box = $('[data-testid="kit-empty"]')!;
    expect(kids(box)).toEqual(['p.kit-empty-overline', 'h2.kit-greeting', 'p.kit-empty-sub', 'div.kit-chips-head', 'ul.kit-chips']);
    expect(box.dataset.mood).toBe('needs');
    expect($('.kit-empty-overline .kit-mood-dot')!.dataset.mood).toBe('needs');
    expect($('.kit-chips-head')!.textContent).toBe('Picked for you1 blocked');
    expect($('.kit-chips-aside')!.textContent).toBe('1 blocked');
    expect($('.kit-chips')!.dataset.variant).toBe('rows');
    expect($$('.kit-chip').map(c => c.dataset.tone)).toEqual(['needs', undefined]);
  });

  it('no mood: no dot; no chips: no header', async () => {
    await render(h(kit.ChatEmpty, { chips: [], onChip() {}, overline: 'Today', chipsHeader: 'Picked for you' }));
    expect($('.kit-mood-dot')).toBeNull();
    expect($('.kit-chips-head')).toBeNull();
  });
});

describe('TierPicker and Menu slots (0.8.0)', () => {
  it('defaults are unchanged: one span per option plus its meta, a plain trigger, no hover', async () => {
    await render(h(kit.TierPicker, { value: 'standard', onChange() {}, options: [{ tier: 'standard', price: '$0.01' }] }));
    expect(kids($('[data-testid="kit-tier"]'))).toEqual(['button.kit-menu-trigger']);
    expect(kids($('[data-testid="kit-tier-trigger"]'))).toEqual(['span', 'span']);
    await click($('[data-testid="kit-tier-trigger"]'));
    const opt = $$('[data-testid="kit-tier-panel"] .kit-option')[1];
    expect(kids(opt)).toEqual(['span', 'span.kit-option-meta']);
    expect(opt.dataset.detail).toBeUndefined();
  });

  it('a second detail line per option, Auto\'s too, and an extra on the trigger', async () => {
    await render(h(kit.TierPicker, {
      value: null, onChange() {}, autoMeta: null, autoDetail: 'Routed per message', triggerExtra: '$0.04',
      options: [{ tier: 'standard', detail: 'model-s · $0.003 / $0.015 per 1k' }],
    }));
    expect($('[data-testid="kit-tier-trigger"] .kit-trigger-extra')!.textContent).toBe('$0.04');
    await click($('[data-testid="kit-tier-trigger"]'));
    const [auto, std] = $$('[data-testid="kit-tier-panel"] .kit-option');
    expect(kids(auto)).toEqual(['span.kit-option-text']);
    expect(auto.querySelector('.kit-option-detail')!.textContent).toBe('Routed per message');
    expect(std.dataset.detail).toBe('true');
    expect(std.querySelector('.kit-option-name')!.textContent).toBe('Standard');
    expect(std.querySelector('.kit-option-detail')!.textContent).toBe('model-s · $0.003 / $0.015 per 1k');
  });

  it('hover: a tooltip beside the trigger, on ToolsMenu and TierPicker', async () => {
    await render(h(kit.TierPicker, { value: null, onChange() {}, hover: h('span', null, 'This chat: $0') }));
    const tip = $('[data-testid="kit-tier-hover"]')!;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.classList.contains('kit-menu-hover')).toBe(true);
    expect(tip.previousElementSibling?.getAttribute('data-testid')).toBe('kit-tier-trigger');
    await render(h(kit.ToolsMenu, { rows: [], onChange() {}, hover: 'Allow nothing yet' }));
    expect($('[data-testid="kit-tools-hover"]')!.textContent).toBe('Allow nothing yet');
  });

  it('the scrim reads --kit-scrim (carried into the sheet), falling back to the old ink mix', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.kit-sheet-scrim { position: absolute; inset: 0; background: var(--kit-scrim, color-mix(in srgb, var(--kit-ink) 28%, transparent)); }');
    // No default: an app that sets nothing gets exactly the 0.6 scrim.
    const theme = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');
    expect(theme).not.toMatch(/^\s*--kit-scrim:/m);
    expect(kit.KIT_CSS_VARS).toContain('--kit-scrim');
    // The hover detail only shows on a hovering pointer on wide screens, never while open.
    expect(css).toContain('@media (hover: hover) and (min-width: 640px) {\n  .kit-menu:not([data-open]):hover > .kit-menu-hover { display: block; }');
    // The fold only folds on a phone.
    expect(css).toMatch(/@media \(max-width: 639px\) \{\n {2}\.kit-fold-toggle \{ display: flex;[^]*?\.kit-fold:not\(\[data-open\]\) \{ display: none; \}/);
  });
});
