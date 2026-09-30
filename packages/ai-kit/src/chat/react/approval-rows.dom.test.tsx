/**
 * 0.13.0: one approval card per turn, a row per write
 * (docs/design/chat-write-approval-v2.md, "One card per turn, N rows").
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
const { encodeApprovalPreview, ONE_CARD_PER_TURN_REASON, ROW_CAP_REASON } = await import('@builddai/ai-kit/chat/contract');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const render = async (el: unknown) => { await act(async () => { root.render(el as never); }); };
const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const sender = (i: number, label: string) => ({
  type: 'tool-mute_sender', toolCallId: `c${i}`, state: 'approval-requested', input: { sender: label },
  approval: {
    id: `a${i}`,
    requestReason: encodeApprovalPreview({
      v: 1, verb: 'Auto-dismiss', target: { kind: 'sender', id: label, label },
      changes: [{ label: 'Mail from', before: 'inbox', after: 'dismissed' }], fingerprint: `f${i}`,
    }),
  },
});
const three = () => [sender(1, 'billing@acme-energy.example'), sender(2, 'survey@reviews.example'), sender(3, 'news@shop.example')];
const held = (i: number, reason = ROW_CAP_REASON) => ({
  type: 'tool-mute_sender', toolCallId: `c${i}`, state: 'output-denied', input: { sender: `x${i}@example` },
  approval: { id: `a${i}`, approved: false, isAutomatic: true, reason },
});

describe('ApprovalRowsCard', () => {
  it('one card, a row per write, all checked; the batch headline is the verb and each row its target', async () => {
    await render(h(kit.ApprovalRowsCard, { parts: three(), onRespond() {} }));
    expect($$('[data-testid="kit-approval-rows"]')).toHaveLength(1);
    expect($('.kit-card-title')!.textContent).toBe('Auto-dismiss · 3');
    expect($$('.kit-apr-title').map(e => e.textContent)).toEqual(['billing@acme-energy.example', 'survey@reviews.example', 'news@shop.example']);
    expect($$('[data-testid="kit-approval-row-check"]').every(c => (c as HTMLInputElement).checked)).toBe(true);
    expect($('[data-testid="kit-approval-confirm"]')!.textContent).toBe('Confirm 3');
    expect($('[data-testid="kit-approval-deny"]')!.textContent).toBe('Discard all');
  });

  it('Confirm answers every row: checked ones approved, an unchecked one declined as the person\'s', async () => {
    const answers: unknown[] = [];
    await render(h(kit.ApprovalRowsCard, { parts: three(), onRespond: (...a: unknown[]) => answers.push(a) }));
    await click($$('[data-testid="kit-approval-row-check"]')[1]);
    expect($$('[data-testid="kit-approval-row"]')[1].dataset.checked).toBe('false');
    expect($$('.kit-apr-note')[1].textContent).toBe('won’t run');
    expect($('[data-testid="kit-approval-confirm"]')!.textContent).toBe('Confirm 2');
    await click($('[data-testid="kit-approval-confirm"]'));
    expect(answers).toEqual([['a1', true, undefined], ['a2', false, 'Unchecked by the user'], ['a3', true, undefined]]);
    expect($('[data-testid="kit-approval-confirm"]')!.textContent).toBe('Applying…');
    expect(($('[data-testid="kit-approval-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('nothing checked: Confirm is off, Discard all still works', async () => {
    const answers: unknown[] = [];
    await render(h(kit.ApprovalRowsCard, { parts: three(), onRespond: (...a: unknown[]) => answers.push(a) }));
    for (const c of $$('[data-testid="kit-approval-row-check"]')) await click(c);
    expect(($('[data-testid="kit-approval-confirm"]') as HTMLButtonElement).disabled).toBe(true);
    await click($('[data-testid="kit-approval-deny"]'));
    expect(answers).toEqual([['a1', false, 'Discarded by the user'], ['a2', false, 'Discarded by the user'], ['a3', false, 'Discarded by the user']]);
  });

  it('a long target is one truncated line; a tap shows the full target and what changes', async () => {
    const long = 'a-very-long-sender-address-that-would-never-fit-a-phone@subdomain.reviews.example';
    await render(h(kit.ApprovalRowsCard, { parts: [sender(1, long), sender(2, 'b@example')], onRespond() {} }));
    const detail = $$('[data-testid="kit-approval-row-detail"]')[0];
    expect(detail.hidden).toBe(true);
    await click($$('[data-testid="kit-approval-row-expand"]')[0]);
    expect($$('[data-testid="kit-approval-row-expand"]')[0].getAttribute('aria-expanded')).toBe('true');
    expect(detail.hidden).toBe(false);
    expect(detail.querySelector('.kit-apr-full')!.textContent).toBe(long);
    expect(detail.textContent).toContain('Mail from');
  });

  it('settled: each row says how it went (done, changed since shown, discarded), never all-or-nothing', async () => {
    const [a, b, c] = three();
    const parts = [
      { ...a, state: 'output-available', approval: { ...a.approval, approved: true }, output: { data: 'ok' } },
      { ...b, state: 'output-available', approval: { ...b.approval, approved: true }, output: { data: 'Error: nothing changed: survey@reviews.example changed since the card was shown. Show the person the current state and ask again.' } },
      { ...c, state: 'output-denied', approval: { ...c.approval, approved: false } },
    ];
    await render(h(kit.ApprovalRowsCard, { parts, onRespond() {}, approverName: 'Sam' }));
    expect($('[data-testid="kit-approval-rows"]')!.dataset.state).toBe('done');
    expect($$('[data-testid="kit-approval-row"]').map(r => r.dataset.outcome)).toEqual(['ran', 'changed', 'discarded']);
    expect($$('.kit-apr-note').map(e => e.textContent)).toEqual(['done · Sam', 'changed since shown · nothing ran', 'discarded · nothing changed']);
    expect($('.kit-eyebrow')!.textContent).toBe('1 done · 1 changed · 1 discarded');
    expect($('[data-testid="kit-approval-confirm"]')).toBeNull();
  });

  it('a write past the row cap is "not proposed yet", never "discarded", and has no toggle', async () => {
    await render(h(kit.ApprovalRowsCard, { parts: three(), held: [held(9)], onRespond() {} }));
    const rows = $$('[data-testid="kit-approval-row"]');
    expect(rows).toHaveLength(4);
    expect(rows[3].dataset.outcome).toBe('held');
    expect(rows[3].querySelector('.kit-apr-note')!.textContent).toBe('not proposed yet · the card is full');
    expect(rows[3].querySelector('input')).toBeNull();
    expect(container.textContent).not.toMatch(/discarded/i);
    expect($('[data-testid="kit-approval-confirm"]')!.textContent).toBe('Confirm 3');
  });

  it('the same thing made several times in one place: headed by both, each row by what it makes', async () => {
    const task = (i: number, title: string) => ({ ...sender(i, 'x'), approval: { id: `a${i}`, requestReason: encodeApprovalPreview({ v: 1, verb: 'New task in', target: { kind: 'mission', id: 'm1', label: 'Invoices' }, changes: [{ label: 'Title', before: null, after: title }, { label: 'Brief', before: null, after: `do ${title}` }], fingerprint: 'f' }) } });
    await render(h(kit.ApprovalRowsCard, { parts: [task(1, 'PDFs'), task(2, 'Receipts')], onRespond() {} }));
    expect($('.kit-card-title')!.textContent).toBe('New task in Invoices · 2');
    expect($$('.kit-apr-title').map(e => e.textContent)).toEqual(['PDFs', 'Receipts']);
    expect($$('.kit-apr-note').map(e => e.textContent)).toEqual(['Brief: do PDFs', 'Brief: do Receipts']);
  });

  it('many changes to one subject: headed by the subject, each row its verb', async () => {
    const one = (i: number, verb: string) => ({ ...sender(i, 'x'), approval: { id: `a${i}`, requestReason: encodeApprovalPreview({ v: 1, verb, target: { kind: 'task', id: 't1', label: 'checkout' }, changes: [], fingerprint: 'f' }) } });
    await render(h(kit.ApprovalRowsCard, { parts: [one(1, 'Hold task'), one(2, 'Message agent')], onRespond() {} }));
    expect($('.kit-card-title')!.textContent).toBe('checkout');
    expect($$('.kit-apr-title').map(e => e.textContent)).toEqual(['Hold task', 'Message agent']);
  });
});

describe('approvalRowGroup and the thread', () => {
  it('two or more writes in a message are rows; one write keeps its own card', () => {
    expect(kit.approvalRowGroup([sender(1, 'a')])).toBeNull();
    const g = kit.approvalRowGroup([...three(), held(4)])!;
    expect(g.rows.map(p => p.toolCallId)).toEqual(['c1', 'c2', 'c3']);
    expect(g.held.map(p => p.toolCallId)).toEqual(['c4']);
  });

  it('an admin write (typed confirmation) is never a row', () => {
    const admin = { ...sender(5, 'all'), approval: { id: 'a5', requestReason: encodeApprovalPreview({ v: 1, verb: 'Delete', target: { kind: 'ws', id: 'w', label: 'ws' }, changes: [], fingerprint: 'f', confirmText: 'ws' }) } };
    expect(kit.approvalRowGroup([admin, held(6, ONE_CARD_PER_TURN_REASON)])).toBeNull();
    expect(kit.approvalRowGroup([admin, sender(1, 'a'), sender(2, 'b')])!.rows.map(p => p.toolCallId)).toEqual(['c1', 'c2']);
  });

  it('ChatThread draws a message\'s writes as one card at the first of them', async () => {
    const messages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'Three filters.' }, ...three(), held(9), { type: 'text', text: 'Say which.' }] }];
    await render(h(kit.ChatThread, { messages, onApprovalResponse() {} }));
    expect($$('[data-testid="kit-approval-rows"]')).toHaveLength(1);
    expect($$('[data-testid="kit-approval"]')).toHaveLength(0);
    expect($$('[data-testid="kit-approval-row"]')).toHaveLength(4);
    // In place: after the lead-in, before the closing text.
    expect(container.textContent!.indexOf('Three filters.')).toBeLessThan(container.textContent!.indexOf('Auto-dismiss · 3'));
    expect(container.textContent!.indexOf('Auto-dismiss · 3')).toBeLessThan(container.textContent!.indexOf('Say which.'));
  });

  it('renderTool returning null draws nothing, not an empty frame', async () => {
    const messages = [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'Hi.' }, sender(1, 'a')] }];
    await render(h(kit.ChatThread, { messages, renderTool: () => null }));
    expect($('[data-message-id="m1"]')!.children).toHaveLength(1);
  });
});

describe('approval rows at a narrow column (320px)', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  };

  it('rows stack in one column that can shrink, and each folded line truncates', () => {
    expect(rule('.kit-apr-row')).toContain('grid-template-columns: 24px minmax(0, 1fr)');
    expect(rule('.kit-apr-title, .kit-apr-note')).toMatch(/overflow: hidden;.*text-overflow: ellipsis;.*white-space: nowrap/);
    expect(rule('.kit-apr-full')).toContain('overflow-wrap: anywhere');
  });

  it('a row keeps its height from awaiting to settled: the check box and the mark share one 44px slot', () => {
    expect(rule('.kit-apr-check, .kit-apr-mark')).toContain('height: 44px');
    expect(rule('button.kit-apr-main, .kit-apr-main')).toContain('min-height: 44px');
  });
});
