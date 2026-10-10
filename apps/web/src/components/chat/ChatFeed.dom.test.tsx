/**
 * The feed, mounted (happy-dom): approval cards post the approval id back,
 * tool rows expand to their raw input/output, question cards answer through
 * the respond path, and a kind with no renderer shows its fallback text.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/chat' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ChatFeed } = await import('./ChatFeed');
const { ChatActionsProvider, DEFAULT_CHAT_ACTIONS } = await import('./ChatActions');
const { ObjectStoreProvider } = await import('./objects/ObjectStoreProvider');
const fixtures = await import('../../app/app/dev/chat/chat-fixtures');

type Msgs = Parameters<typeof ChatFeed>[0]['messages'];

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const calls: Array<[string, boolean]> = [];
const answers: Array<{ workerId: string; message: string }> = [];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls.length = 0;
  answers.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(messages: Msgs, state: Parameters<typeof fixtures.fixtureViews>[0] = 'split', extra: Record<string, unknown> = {}) {
  const views = fixtures.fixtureViews(state);
  const source = { load: async (r: { kind: string; id: string }) => { const v = views[`${r.kind}:${r.id}`]; if (!v) throw new Error('Not found'); return v; } };
  const actions = {
    ...DEFAULT_CHAT_ACTIONS,
    respondToApproval: (id: string, ok: boolean) => { calls.push([id, ok]); },
    answerQuestion: async (i: { workerId: string; message: string }) => { answers.push(i); },
    viewerName: 'Maya',
    ...extra,
  };
  await act(async () => {
    root.render(
      <ObjectStoreProvider source={source}>
        <ChatActionsProvider value={actions}>
          <ChatFeed messages={messages} agent={fixtures.ORGANIZER} />
        </ChatActionsProvider>
      </ObjectStoreProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[];
/** A Thinking panel row's visible label (the kit adds a screen-reader state after it). */
const stepText = (li: HTMLElement) => li.querySelector('.kit-step-mark + span')?.textContent?.trim();
/** The live line's label while a turn streams. */
const liveLabel = () => container.querySelector('[data-testid="kit-thinking-live"] .kit-live-label')?.textContent ?? null;
/** Tap the live line open. */
async function expand() {
  await act(async () => { (container.querySelector('[data-testid="kit-thinking-live"]') as HTMLButtonElement).click(); });
}
/** Tap every finished turn's folded line open (happy-dom fires `toggle` when `open` flips). */
async function unfold() {
  for (const d of qa('[data-testid="kit-thinking"][data-settled]') as HTMLDetailsElement[]) {
    if (d.open) continue;
    await act(async () => { d.open = true; });
  }
}

// One card per turn, a row per write (docs/design/chat-write-approval-v2.md).
describe('the live line while a turn streams', () => {
  const live = async (messages: Msgs, status: 'streaming' | 'submitted' | 'ready' = 'streaming') => {
    const views = fixtures.fixtureViews('split');
    const source = { load: async (r: { kind: string; id: string }) => views[`${r.kind}:${r.id}`] ?? { title: r.id } };
    await act(async () => {
      root.render(
        <ObjectStoreProvider source={source}>
          <ChatActionsProvider value={DEFAULT_CHAT_ACTIONS}>
            <ChatFeed messages={messages} agent={fixtures.ORGANIZER} status={status} />
          </ChatActionsProvider>
        </ObjectStoreProvider>,
      );
    });
  };
  const panelText = () => q('[data-testid="kit-thinking"]')?.textContent ?? '';

  it('a long turn collapsed: the square, the live step and one pinned key step; no header, no rail, no list', async () => {
    await live(fixtures.chatFixture('streaming-long').messages as Msgs);
    expect(liveLabel()).toBe('Looking through recent activity');
    expect(q('[data-testid="kit-thinking-live"] .kit-step-mark')).not.toBeNull();
    expect(q('[data-testid="kit-thinking-pinned"]')?.textContent).toContain('Check it with you');
    expect(qa('[data-testid="kit-thinking-pinned"]')).toHaveLength(1);
    expect(container.textContent?.toLowerCase()).not.toContain('thinking');
    expect(q('.buildd-thinking-title')).toBeNull();
    expect(qa('[data-testid="kit-thinking"] > .kit-steps')).toHaveLength(0);
    expect(panelText()).not.toMatch(/Read 2 tasks|Looked over|Couldn't/);
  });

  it('expanded: key steps in order, routine runs folded with their count, the live step last', async () => {
    await live(fixtures.chatFixture('streaming-long').messages as Msgs);
    await expand();
    expect(q('[data-testid="kit-thinking-live"]')!.getAttribute('aria-expanded')).toBe('true');
    const rows = qa('[data-testid="kit-thinking"] > .kit-steps > li').map(li => (li.classList.contains('kit-step-fold')
      ? `fold ${li.querySelector('.kit-step-fold-count')!.textContent}`
      : `${li.dataset.weight} ${stepText(li)}`));
    expect(rows).toEqual([
      'fold 3 routine steps', "key Couldn't check the change", 'fold 4 routine steps', 'key Drafted a mission',
      'fold 2 routine steps', 'key Check it with you', 'routine Checked the budget', 'routine Looking through recent activity',
    ]);
  });

  it('sent, nothing streamed yet: the square alone, no words', async () => {
    await live(fixtures.chatFixture('starting').messages as Msgs, 'submitted');
    const line = q('[data-testid="kit-thinking-live"]')!;
    expect(line.querySelector('.kit-step-mark')).not.toBeNull();
    expect(line.getAttribute('aria-label')).toBe('Buildd is working');
    expect(panelText()).toBe('');
  });

  it('a streaming message with no steps yet is the square alone too', async () => {
    await live([
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a', role: 'assistant', parts: [{ type: 'step-start' }] },
    ] as unknown as Msgs);
    expect(q('[data-testid="kit-thinking-live"] .kit-step-mark')).not.toBeNull();
    expect(panelText()).toBe('');
  });

  it('a write without a card pins as its row while the turn works; its object mounts once, in the results, when the turn lands', async () => {
    const write = (id: string, taskId: string, title: string) => [
      { type: 'tool-create_task', toolCallId: id, state: 'output-available', input: { title }, output: { data: {}, objects: [{ kind: 'task', id: taskId, fallbackText: title }] } },
      { type: 'data-step', id, data: { id, label: `Drafted ${title}`, state: 'done', weight: 'key' } },
    ];
    const read = (id: string, state = 'done') => [
      { type: 'tool-get_task', toolCallId: id, state: state === 'done' ? 'output-available' : 'input-available', input: {}, output: { data: {}, objects: [{ kind: 'task', id: `r-${id}`, fallbackText: 'Read one' }] } },
      { type: 'data-step', id, data: { id, label: state === 'done' ? 'Read a task' : 'Reading a task', state, weight: 'routine' } },
    ];
    const msg = (parts: unknown[]) => [{ id: 'a', role: 'assistant', parts }] as unknown as Msgs;
    await live(msg([...read('r1'), ...read('r2', 'active')]));
    expect(q('[data-testid="kit-thinking-pinned"]')).toBeNull();
    await live(msg([...read('r1'), ...write('w1', 'task-a', 'First'), ...read('r2', 'active')]));
    expect(q('[data-testid="kit-thinking-pinned"]')?.textContent).toContain('Drafted First');
    // No card yet: it would only move once the answer streams in above it.
    expect(q('[data-testid="object-card"]')).toBeNull();
    await live(msg([...read('r1'), ...write('w1', 'task-a', 'First'), ...write('w2', 'task-b', 'Second'), ...read('r2', 'active')]));
    expect(qa('[data-testid="kit-thinking-pinned"]')).toHaveLength(1);
    expect(q('[data-testid="kit-thinking-pinned"]')!.textContent).toContain('Second');
    expect(q('[data-testid="kit-thinking-pinned"]')!.textContent).not.toContain('First');
    const done = msg([...read('r1'), ...write('w1', 'task-a', 'First'), ...write('w2', 'task-b', 'Second'), ...read('r2'), { type: 'text', text: 'Filed both.' }]);
    await live(done, 'ready');
    const groups = qa('[data-testid="feed-group"]');
    expect(groups.map(g => g.dataset.group)).toEqual(['created', 'created', 'referenced']);
    expect(groups[0].textContent).toContain('First');
    expect(groups[1].textContent).toContain('Second');
  });

  it('a message saved before steps were weighed still unfolds sensibly: its failure is key', async () => {
    await live([{ id: 'a', role: 'assistant', parts: [
      { type: 'data-step', id: 'a1', data: { id: 'a1', label: 'Read a task', state: 'done' } },
      { type: 'data-step', id: 'a2', data: { id: 'a2', label: 'Looked over the tasks', state: 'done' } },
      { type: 'data-step', id: 'a3', data: { id: 'a3', label: "Couldn't open the task", state: 'done' } },
      { type: 'data-step', id: 'a4', data: { id: 'a4', label: 'Reading a mission', state: 'active' } },
    ] }] as unknown as Msgs);
    expect(q('[data-testid="kit-thinking-pinned"]')?.textContent).toContain("Couldn't open the task");
    await expand();
    expect(qa('[data-testid="kit-thinking"] > .kit-steps > li').map(li => li.querySelector('.kit-step-fold-count')?.textContent ?? `${li.dataset.weight} ${stepText(li)}`)).toEqual([
      '2 routine steps', "key Couldn't open the task", 'routine Reading a mission',
    ]);
  });

  it('a done long turn folds to its summary and unfolds into the same filtered list', async () => {
    await render(fixtures.chatFixture('streaming-long').messages as Msgs);
    expect(q('[data-testid="kit-thinking-summary"]')?.textContent).toBe('Did 14 steps · filed 1 mission');
    await unfold();
    const rows = qa('[data-testid="kit-thinking"] > .kit-steps > li').map(li => li.querySelector('.kit-step-fold-count')?.textContent ?? stepText(li));
    expect(rows).toEqual([
      '3 routine steps', "Couldn't check the change", '4 routine steps', 'Drafted a mission', '2 routine steps', 'Check it with you', '2 routine steps',
    ]);
  });
});

describe('approval rows', () => {
  const rows = () => qa('[data-testid="kit-approval-row"]');

  it('three writes in one turn are one card with three rows, all checked', async () => {
    await render(fixtures.chatFixture('rows').messages as Msgs);
    expect(qa('[data-testid="approval-rows"]')).toHaveLength(1);
    expect(qa('[data-testid="approval-card"]')).toHaveLength(0);
    expect(q('[data-testid="approval-rows"]')!.dataset.rows).toBe('3');
    // Three tasks in one mission: the headline says where, each row what it files.
    expect(q('[data-testid="approval-rows"] .kit-card-title')!.textContent).toBe('New task in Multi-currency invoices · 3');
    expect(rows().map(r => r.querySelector('.kit-apr-title')!.textContent)).toEqual(fixtures.chatFixture('rows').messages.at(-1)!.parts.filter(p => p.type === 'tool-create_task').map(p => (p as { input: { title: string } }).input.title));
    expect(rows()[0].querySelector('.kit-apr-note')!.textContent).toBe('Brief: A follow-up from the currency review.');
    expect(qa('[data-testid="kit-approval-row-check"]').every(c => (c as HTMLInputElement).checked)).toBe(true);
    expect(q('[data-testid="kit-approval-confirm"]')!.textContent).toBe('Confirm 3');
  });

  it('one Confirm answers every row; an unchecked row is declined, not run', async () => {
    await render(fixtures.chatFixture('rows').messages as Msgs);
    await act(async () => { (qa('[data-testid="kit-approval-row-check"]')[1] as HTMLInputElement).click(); });
    await act(async () => { q('[data-testid="kit-approval-confirm"]')!.click(); });
    expect(calls).toEqual([['approval-row-0', true], ['approval-row-1', false], ['approval-row-2', true]]);
  });

  it('Discard all declines every row', async () => {
    await render(fixtures.chatFixture('rows').messages as Msgs);
    await act(async () => { q('[data-testid="kit-approval-deny"]')!.click(); });
    expect(calls).toEqual([['approval-row-0', false], ['approval-row-1', false], ['approval-row-2', false]]);
  });

  it('a full card: eight rows, and the ninth is "not proposed yet", never "discarded"', async () => {
    await render(fixtures.chatFixture('rows-full').messages as Msgs);
    expect(rows()).toHaveLength(9);
    expect(qa('[data-testid="kit-approval-row-check"]')).toHaveLength(8);
    expect(rows()[8].dataset.outcome).toBe('held');
    expect(rows()[8].textContent).toContain('not proposed yet · the card is full');
    expect(container.textContent).not.toMatch(/discarded/i);
    expect(q('[data-testid="kit-approval-confirm"]')!.textContent).toBe('Confirm 8');
  });

  it('answered: each row says how it went, and what ran renders after the card', async () => {
    await render(fixtures.chatFixture('rows-done').messages as Msgs);
    expect(rows().map(r => r.dataset.outcome)).toEqual(['ran', 'changed', 'discarded', 'ran']);
    expect(rows()[1].textContent).toContain('changed since shown');
    expect(q('[data-testid="kit-approval-confirm"]')).toBeNull();
    const card = q('[data-testid="approval-rows"]')!;
    const task = q('[data-testid="object-card"][data-kind="task"]');
    expect(task).not.toBeNull();
    expect(card.compareDocumentPosition(task!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a mission draft never joins the rows: it keeps its own full card', async () => {
    const msgs = fixtures.chatFixture('propose').messages as Msgs;
    const rowsMsg = (fixtures.chatFixture('rows').messages as Msgs).at(-1)!;
    const last = msgs.at(-1)!;
    const mixed = [...msgs.slice(0, -1), { ...last, parts: [...last.parts, ...rowsMsg.parts.filter(p => p.type !== 'text').map((p, i) => ({ ...p, toolCallId: `row-${i}` }))] }] as Msgs;
    await render(mixed);
    expect(qa('[data-kind="mission"]')).toHaveLength(1);
    expect(qa('[data-testid="approval-rows"] [data-testid="kit-approval-row"]')).toHaveLength(3);
  });
});

describe('approval card', () => {
  it('once filed, the row names it in words and nothing around it says it is unfiled', async () => {
    await render(fixtures.chatFixture('confirmed').messages as Msgs);
    const row = qa('[data-testid="tool-call-row"][data-tool="manage_missions"]').find(r => r.textContent?.includes('approved by Maya'))!;
    expect(row).toBeDefined();
    expect(row.textContent).toContain('New mission');
    expect(row.textContent).not.toContain('manage_missions');
    expect(container.textContent).not.toContain('until you confirm');
  });

  it('Confirm echoes the approval id back, once; the buttons then lock', async () => {
    await render(fixtures.chatFixture('propose').messages as Msgs);
    const card = q('[data-testid="approval-card"]');
    expect(card?.dataset.state).toBe('awaiting');
    // What it is in words; the tool it runs through stays out of the card.
    expect(card?.textContent).toContain('New mission');
    expect(card?.textContent).not.toContain('manage_missions');
    expect(card?.textContent).not.toContain('not filed');
    expect(card?.textContent).not.toContain('files through');
    // The kit's card, with buildd's labels.
    const confirm = q('[data-testid="kit-approval-confirm"]') as HTMLButtonElement;
    expect(card?.querySelector('.buildd-approval')).not.toBeNull();
    expect(confirm.textContent).toBe('Confirm & file');
    await act(async () => { confirm.click(); });
    await act(async () => { confirm.click(); });
    expect(calls).toEqual([['approval-1', true]]);
    expect(confirm.textContent).toBe('Filing…');
    expect(q('[data-testid="approval-card"]')?.dataset.state).toBe('deciding');
    expect((q('[data-testid="kit-approval-deny"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the head names the write and its workspace; the draft is the card body', async () => {
    await render(fixtures.chatFixture('propose').messages as Msgs, 'split', { workspaceName: (id: string) => (id === fixtures.WS.id ? fixtures.WS.name : null) });
    const head = q('[data-testid="approval-card"] .kit-card-head')!;
    expect(head.querySelector('.kit-eyebrow')?.textContent).toBe('Approval needed');
    expect(head.querySelector('.kit-card-tag')?.textContent).toBe('New mission');
    expect(head.querySelector('[data-testid="approval-workspace"]')?.textContent).toBe(fixtures.WS.name);
    expect(q('[data-testid="approval-card"] .kit-card-title')?.textContent).toBe('Multi-currency invoices');
    expect(q('[data-testid="approval-card"] .kit-approval-body')?.textContent).toContain('their own currency');
  });

  // On a phone the full draft was taller than the viewport: Confirm was in view
  // but the header and Discard were not. Details fold behind a toggle there.
  it('phone: details fold behind "Show details"; header and all actions stay in the card', async () => {
    await render(fixtures.chatFixture('propose').messages as Msgs);
    // The kit's fold: the toggle and the folded block show below 640px only (styles.css).
    const details = q('[data-testid="kit-approval-details"]')!;
    const toggle = q('[data-testid="kit-approval-fold"]') as HTMLButtonElement;
    expect(details.classList.contains('kit-fold')).toBe(true);
    expect(details.dataset.open).toBeUndefined();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Show details');
    expect(toggle.textContent).toContain('4 criteria · constraints · plan');
    const title = q('[data-testid="approval-card"] .kit-card-title')!;
    expect(details.contains(title)).toBe(false);
    expect(details.contains(q('[data-testid="approval-draft-criteria"]'))).toBe(true);
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('Hide details');
    expect(details.dataset.open).toBe('true');
    for (const id of ['kit-approval-confirm', 'kit-approval-edit', 'kit-approval-deny']) expect(q(`[data-testid="${id}"]`)).not.toBeNull();
  });

  it('Edit prefills a change to the draft', async () => {
    const prefills: string[] = [];
    await render(fixtures.chatFixture('propose').messages as Msgs, 'split', { prefillComposer: (t: string) => { prefills.push(t); } });
    await act(async () => { (q('[data-testid="kit-approval-edit"]') as HTMLButtonElement).click(); });
    expect(prefills).toEqual(['Change the draft "Multi-currency invoices": ']);
  });

  it('Discard answers false', async () => {
    await render(fixtures.chatFixture('propose').messages as Msgs);
    await act(async () => { q('[data-testid="kit-approval-deny"]')!.click(); });
    expect(calls).toEqual([['approval-1', false]]);
  });

  it('a denied proposal files nothing and says so', async () => {
    await render(fixtures.chatFixture('denied').messages as Msgs);
    expect(q('[data-testid="approval-card"]')?.dataset.state).toBe('denied');
    expect(q('[data-testid="approval-card"]')?.textContent).toContain('nothing filed');
    // One line, the kit's settled row, headed by what the write was.
    const row = q('[data-testid="approval-card"] .kit-approval-row')!;
    expect(row.querySelector('.kit-card-title')?.textContent).toBe('New mission');
    expect(q('[data-testid="kit-approval-confirm"]')).toBeNull();
    expect(q('[data-kind="mission"]')).toBeNull();
  });

  // A new mission's draft stands alone, so a second write that turn waited.
  // It used to read "discarded · nothing filed", as if the person had
  // discarded something they never saw.
  it('a write held back by a mission draft\'s card is "not proposed yet", never "discarded"', async () => {
    await render(fixtures.chatFixture('capped').messages as Msgs, 'confirmed');
    const capped = q('[data-testid="approval-card"][data-state="skipped"]')!;
    expect(capped.dataset.state).toBe('skipped');
    expect(capped.querySelector('.kit-card-title')?.textContent).toBe('New task');
    expect(capped.textContent).toContain('not proposed yet · another card is up');
    expect(container.textContent).not.toMatch(/discarded/i);
    // The first write still reads approved.
    expect(qa('[data-testid="tool-call-row"]').some(r => r.dataset.tool === 'manage_missions' && r.textContent?.includes('approved by Maya'))).toBe(true);
  });

  it('once filed, the card is its tool row and the live mission renders under it', async () => {
    await render(fixtures.chatFixture('confirmed').messages as Msgs, 'confirmed');
    expect(q('[data-testid="kit-approval-confirm"]')).toBeNull();
    const row = qa('[data-testid="tool-call-row"]').find(r => r.dataset.tool === 'manage_missions' && r.textContent?.includes('approved by Maya'));
    expect(row?.dataset.state).toBe('done');
    expect(q('[data-testid="object-card"][data-kind="mission"]')?.textContent).toContain('Multi-currency invoices');
  });
});

// A change to something that exists (here a watch on a PR) carries the
// server's before → after preview, and its card is the kit's ApprovalCard.
describe('approval card: a previewed change is the kit card', () => {
  it('shows the preview headline and each change, then echoes the approval id once', async () => {
    await render(fixtures.chatFixture('watch').messages as Msgs, 'watch');
    const card = q('[data-testid="approval-card"]')!;
    expect(card.dataset.kind).toBe('preview');
    expect(card.dataset.state).toBe('awaiting');
    const kit = card.querySelector('[data-testid="kit-approval"]') as HTMLElement;
    expect(kit.className).toContain('buildd-approval');
    expect(kit.textContent).toContain('Watch: PR #421 (billing-web)');
    expect(kit.querySelectorAll('.kit-change')).toHaveLength(3);
    // On a phone the changes fold behind "Show details · 3 changes"; the head names the write.
    expect(kit.querySelector('[data-testid="kit-approval-fold"]')?.textContent).toContain('3 changes');
    expect(kit.querySelector('.kit-card-tag')?.textContent).toBe('Tell me when');
    const confirm = () => card.querySelector('[data-testid="kit-approval-confirm"]') as HTMLButtonElement;
    await act(async () => { confirm().click(); });
    await act(async () => { confirm().click(); });
    expect(calls).toEqual([['approval-watch', true]]);
    expect(q('[data-testid="approval-card"]')!.dataset.state).toBe('deciding');
    expect((card.querySelector('[data-testid="kit-approval-deny"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Discard answers false; Edit prefills a change request', async () => {
    const prefills: string[] = [];
    await render(fixtures.chatFixture('watch').messages as Msgs, 'watch', { prefillComposer: (t: string) => { prefills.push(t); } });
    await act(async () => { (q('[data-testid="kit-approval-edit"]') as HTMLButtonElement).click(); });
    expect(prefills).toEqual(['Change it: ']);
    await act(async () => { (q('[data-testid="kit-approval-deny"]') as HTMLButtonElement).click(); });
    expect(calls).toEqual([['approval-watch', false]]);
  });
});

describe('tool rows', () => {
  it('consecutive read calls group under one header, and a row expands to raw input and output', async () => {
    await render(fixtures.chatFixture('propose').messages as Msgs);
    await unfold();
    const group = q('[data-testid="tool-call-group"]');
    expect(group?.textContent).toContain('3 tool calls');
    expect(group?.textContent).toContain('read-only');
    const first = qa('[data-testid="tool-call-row"]')[0];
    expect(first.textContent).toContain('manage_missions');
    expect(first.textContent).toContain('3 open, none touch currency');
    await act(async () => { (first.querySelector('button') as HTMLButtonElement).click(); });
    expect(first.querySelector('[data-testid="tool-call-raw"]')?.textContent).toContain('"action": "list"');
  });

  it('the rows are the kit\'s, with buildd\'s key args, read classes and result line', async () => {
    const call = (id: string, name: string, input: Record<string, unknown>, output: unknown) =>
      ({ type: `tool-${name}`, toolCallId: id, state: 'output-available', input, output });
    await render([{ id: 'a', role: 'assistant', parts: [
      call('c1', 'manage_missions', { action: 'list', workspaceId: '5f0c7a51-2b9e-4c1e-9d55-0c3a4b1d2e3f', teamId: 'team-a', repo: 'web', workspace: 'billing-web' }, { data: [1, 2], objects: [] }),
      call('c2', 'create_task', { title: 'Fix checkout' }, { data: {}, objects: [], summary: 'filed', allowed: true }),
      { type: 'text', text: 'Done.' },
    ] }] as unknown as Msgs);
    await unfold();
    const group = q('[data-testid="tool-call-group"]')!;
    expect(group.classList.contains('kit-toolcalls')).toBe(true);
    // A write in the run: not read-only.
    expect(group.textContent).not.toContain('read-only');
    const [read, write] = qa('[data-testid="tool-call-row"]');
    expect(read.classList.contains('kit-toolcall')).toBe(true);
    // buildd's arg order (workspace before repo), its skips (teamId), and its count result.
    expect(read.querySelector('.kit-toolcall-args')?.textContent).toBe('· billing-web · web');
    expect(read.querySelector('.kit-toolcall-result')?.textContent).toBe('→ 2 results');
    expect(write.querySelector('[data-testid="tool-call-allowed"]')).not.toBeNull();
  });

  it('while a turn streams, the panel is one live line with the server\'s current step, in plain words', async () => {
    await act(async () => {
      root.render(<ChatFeed messages={fixtures.chatFixture('streaming').messages as Msgs} agent={fixtures.ORGANIZER} status="streaming" />);
    });
    expect(liveLabel()).toBe('Searching what buildd remembers');
    expect(q('[data-testid="kit-thinking-live"]')!.getAttribute('aria-label')).toBe('Buildd is working: Searching what buildd remembers');
    expect(qa('li.kit-step')).toHaveLength(0);
    expect(container.textContent).not.toContain('recall');
    await expand();
    expect(qa('li.kit-step').map(s => [stepText(s), s.dataset.state])).toEqual([
      ['Looked over the missions', 'done'],
      ['Searching what buildd remembers', 'active'],
    ]);
  });

  it('the panel reads only data-step parts: a streaming message\'s labels come from the server, not its tool names', async () => {
    const msgs = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a', role: 'assistant', parts: [
        { type: 'tool-get_task', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
        { type: 'data-step', id: 'c1', data: { id: 'c1', label: 'Read a task', state: 'done' } },
      ] },
    ] as unknown as Msgs;
    await act(async () => { root.render(<ChatFeed messages={msgs} agent={fixtures.ORGANIZER} status="streaming" />); });
    expect(liveLabel()).toBe('Thinking it through');
    await expand();
    expect(qa('li.kit-step').map(stepText)).toEqual(['Read a task', 'Thinking it through']);
  });

  it('a settled turn folds its steps and tool rows under one line, and unfolds on tap', async () => {
    await render(fixtures.chatFixture('streaming').messages as Msgs);
    const fold = q('[data-testid="kit-thinking"][data-settled]') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('[data-testid="kit-thinking-summary"]')?.textContent).toBe('Did 2 steps');
    expect(q('[data-testid="tool-call-row"]')).toBeNull();
    // The answer stays out in the open.
    expect(q('[data-testid="feed-text"]')?.textContent).toContain('Nothing in flight touches currency');
    await unfold();
    // Two routine steps in a row: one dim row that unfolds in place.
    expect(q('.kit-step-fold-count')?.textContent).toBe('2 routine steps');
    await act(async () => { (q('.kit-step-fold-btn') as HTMLButtonElement).click(); });
    expect(qa('li.kit-step').map(stepText)).toEqual(['Looked over the missions', 'Searching what buildd remembers']);
    expect(qa('[data-testid="tool-call-row"]').length).toBeGreaterThan(0);
    // Folding again hides the rows.
    await act(async () => { fold.open = false; });
    expect(q('[data-testid="tool-call-row"]')).toBeNull();
  });

  it('the folded line says what the turn filed', async () => {
    const msgs = [{ id: 'a', role: 'assistant', parts: [
      { type: 'tool-manage_missions', toolCallId: 'c1', state: 'output-available', input: { action: 'list' }, output: { data: [], objects: [] } },
      { type: 'tool-create_task', toolCallId: 'c2', state: 'output-available', input: { title: 'A' }, output: { data: {}, objects: [{ kind: 'task', id: 't1', fallbackText: 'A' }] } },
      { type: 'tool-create_task', toolCallId: 'c3', state: 'output-available', input: { title: 'B' }, output: { data: {}, objects: [{ kind: 'task', id: 't2', fallbackText: 'B' }] } },
      { type: 'text', text: 'Filed both.' },
    ] }] as unknown as Msgs;
    await render(msgs);
    expect(q('[data-testid="kit-thinking-summary"]')?.textContent).toBe('Did 3 steps · filed 2 tasks');
  });

  it('a plain answer has nothing to fold', async () => {
    await render([{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Hi.' }] }] as unknown as Msgs);
    expect(q('[data-testid="kit-thinking"]')).toBeNull();
  });

  it('a call still in flight reads as running', async () => {
    await render(fixtures.chatFixture('streaming').messages as Msgs);
    await unfold();
    expect(qa('[data-testid="tool-call-row"]').some(r => r.dataset.state === 'running')).toBe(true);
  });
});

describe('question card', () => {
  it('tapping an option answers the waiting worker — no second confirm', async () => {
    await render(fixtures.chatFixture('split').messages as Msgs);
    const card = q('[data-testid="object-card"][data-kind="question"]');
    expect(card?.textContent).toContain('Round per line, or only the total?');
    const option = qa('[data-testid="question-option"]')[0];
    await act(async () => { option.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(answers).toEqual([expect.objectContaining({ workerId: 'w-checkout', message: 'Per line: match Stripe' })]);
    expect(q('[data-testid="worker-answer-sent"]')?.textContent).toContain('Per line: match Stripe');
  });
});

describe('objects', () => {
  it('a kind with no renderer yet shows its fallback text', async () => {
    const msgs = [{
      id: 'a', role: 'assistant' as const,
      parts: [{ type: 'tool-list_schedules', toolCallId: 'c', state: 'output-available' as const, input: {}, output: { data: [], objects: [{ kind: 'schedule', id: 's1', workspaceId: 'ws', fallbackText: 'Every weekday at 9' }] } }],
    }];
    await render(msgs as Msgs);
    expect(q('[data-testid="object-card"][data-kind="schedule"]')?.textContent).toContain('Every weekday at 9');
  });

  it('a list read the answer does not name folds into one collapsed row after the reply', async () => {
    const ghost = { kind: 'task' as const, id: 'task-ghost', workspaceId: null, fallbackText: 'Task: queued thing' };
    await render([{
      id: 'a', role: 'assistant' as const,
      parts: [
        { type: 'tool-manage_missions', toolCallId: 'c1', state: 'output-available', input: { action: 'list' },
          output: { summary: '2 results', data: '', objects: [fixtures.missionRef, ghost] } },
        { type: 'text', text: 'One task is running.' },
      ],
    }] as Msgs);
    expect(qa('[data-testid="object-card"]')).toHaveLength(0);
    const more = q('[data-testid="feed-more-objects"] button')!;
    expect(more.textContent).toContain('1 mission · 1 task');
    // The reply comes before the row, in document order.
    expect(q('[data-testid="feed-text"]')!.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { more.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(qa('[data-testid="feed-more-objects"] [data-testid="object-card"]').length).toBeGreaterThan(0);
  });

  it('a run of PRs stacks as one list', async () => {
    await render(fixtures.chatFixture('shipped').messages as Msgs, 'shipped');
    expect(q('[data-testid="pr-list"]')?.textContent).toContain('7 pull requests');
    expect(qa('[data-testid="object-card"][data-kind="pr"]').length).toBe(7);
  });

  it('PRs cluster by mission, then category: the mission work, then the chore', async () => {
    await render(fixtures.chatFixture('shipped').messages as Msgs, 'shipped');
    const clusters = qa('[data-testid="pr-cluster"]');
    expect(clusters.map(c => c.firstElementChild?.textContent)).toEqual(['Multi-currency invoices6', 'Chores1']);
  });
});

describe('model-authored text', () => {
  it("buildd's finished replies speak in the voice face (Newsreader), phone and desktop alike", async () => {
    await render([{ id: 'a', role: 'assistant' as const, parts: [{ type: 'text', text: 'Card refunds already retry on their own.' }] }] as Msgs);
    const cls = (q('[data-testid="feed-text"]')?.className ?? '').split(/\s+/);
    expect(cls).toContain('font-voice');
    expect(cls).not.toContain('font-convo');
    expect(cls.some(c => /^(md|lg):font-/.test(c))).toBe(false);
  });

  it('never auto-loads a remote image: it renders as a plain link the user can choose to follow', async () => {
    const msgs = [{
      id: 'a', role: 'assistant' as const,
      parts: [{ type: 'text', text: 'Here you go ![status](https://example.invalid/pixel.png?d=abc)' }],
    }];
    await render(msgs as Msgs);
    const text = q('[data-testid="feed-text"]');
    expect(text?.querySelector('img')).toBeNull();
    const link = text?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.invalid/pixel.png?d=abc');
    expect(link?.textContent).toContain('status');
  });
});

describe('mission pane', () => {
  it('the docked pane and the phone sheet draw the Board in its compact layout', async () => {
    const { MissionPane } = await import('./objects/MissionObject');
    const view = fixtures.missionView('live');
    for (const variant of ['pane', 'sheet'] as const) {
      await act(async () => {
        root.render(
          <ObjectStoreProvider source={{ load: async () => view }}>
            <MissionPane objRef={fixtures.missionRef} view={view} variant={variant} />
          </ObjectStoreProvider>,
        );
      });
      expect(q('[data-testid="mission-board"]')?.dataset.compact).toBe('true');
    }
  });
});

describe('the thread is the kit\'s', () => {
  it('a log of kit message frames; buildd draws the header, the parts and the events inside', async () => {
    await render(fixtures.chatFixture('watch').messages as Msgs);
    const log = q('[data-testid="kit-thread"]')!;
    expect(log.getAttribute('role')).toBe('log');
    expect(log.classList.contains('buildd-thread')).toBe(true);
    // A lifecycle event (data-buildd-event) is an event frame with buildd's avatar header and notice.
    const ev = qa('.kit-msg[data-role="event"]')[0];
    expect(ev.querySelector('.kit-msg-head')?.textContent).toContain(fixtures.ORGANIZER.name);
    expect(ev.querySelector('[data-testid="watch-notice"]')).not.toBeNull();
    // The person's message: meta above, bubble, and the kit's text is not used.
    const user = qa('.kit-msg[data-role="user"]')[0];
    expect(user.querySelector('[data-testid="feed-user-bubble"]')).not.toBeNull();
    expect(user.querySelector('.kit-text')).toBeNull();
    // Tool calls are buildd's rows, never the kit's default row.
    expect(q('.kit-tool')).toBeNull();
  });

  it('the thumbs are the kit\'s, under a settled answer, through buildd\'s provider', async () => {
    const { TurnFeedbackProvider } = await import('./TurnFeedback');
    const msgs = fixtures.chatFixture('confirmed').messages as Msgs;
    const ids = msgs.filter(m => m.role === 'assistant').map(m => m.id);
    await act(async () => {
      root.render(
        <ObjectStoreProvider source={{ load: async () => { throw new Error('Not found'); } }}>
          <ChatActionsProvider value={DEFAULT_CHAT_ACTIONS}>
            <TurnFeedbackProvider messageIds={ids} pendingId={null} initial={{ [ids[0]]: { signal: 'down', reason: 'too_slow' } }}>
              <ChatFeed messages={msgs} agent={fixtures.ORGANIZER} />
            </TurnFeedbackProvider>
          </ChatActionsProvider>
        </ObjectStoreProvider>,
      );
    });
    const thumbs = qa('.kit-msg-foot [data-testid="kit-feedback"]');
    expect(thumbs).toHaveLength(ids.length);
    expect(thumbs[0].dataset.vote).toBe('down');
    expect(thumbs[0].textContent).toContain('Too slow');
  });
});

describe('a fired watch', () => {
  it('renders as a square notice: the sentence in Newsreader, mono chrome, a link, plain words', async () => {
    await render(fixtures.chatFixture('watch').messages as Msgs);
    const notices = qa('[data-testid="watch-notice"]');
    expect(notices.map(n => n.dataset.tone)).toEqual(['ok', 'attention', 'bad']);

    const merged = notices[0];
    expect(merged.dataset.event).toBe('pr.merged');
    expect(merged.querySelector('p.font-voice')?.textContent).toBe('#418 merged.');
    expect(merged.textContent).toContain('PR #418 · harborline/billing-web');
    expect(merged.textContent).toContain('Round per line at checkout');
    const link = merged.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/harborline/billing-web/pull/418');
    expect(link.textContent).toContain('Open PR');

    expect(notices[1].querySelector('p.font-voice')?.textContent).toBe('Dual-currency CSV asked a question.');
    expect((notices[1].querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe('/app/tasks/task-export');
    expect(notices[2].querySelector('p.font-voice')?.textContent).toBe('CI failed on #421.');

    // The watch's own tool row is square too (v3 foreground), not a pill.
    await unfold();
    const rows = qa('[data-testid="tool-call-row"], [data-testid="tool-call-group"]');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.className).not.toMatch(/rounded/);

    for (const n of notices) {
      // Square, and never a tool, event id or route name.
      expect(n.className).not.toMatch(/rounded/);
      expect(n.textContent).not.toMatch(/list_watches|unwatch|pr\.merged|task\.needs_input|\/api\//);
    }
  });
});

// Task b4f273ac: prose written early in a long turn shows at once; the final
// answer replaces it in place, and a finished turn shows only the final answer.
describe("a turn's answer: live, then replaced in place", () => {
  const frames = fixtures.revisedFrames();
  const show = async (f: { messages: Msgs | ReturnType<typeof fixtures.revisedFrames>[number]['messages']; status: 'streaming' | 'ready' }) => {
    const views = fixtures.fixtureViews('split');
    const source = { load: async (r: { kind: string; id: string }) => views[`${r.kind}:${r.id}`] ?? { title: r.id } };
    await act(async () => {
      root.render(
        <ObjectStoreProvider source={source}>
          <ChatActionsProvider value={DEFAULT_CHAT_ACTIONS}>
            <ChatFeed messages={f.messages as Msgs} agent={fixtures.ORGANIZER} status={f.status} />
          </ChatActionsProvider>
        </ObjectStoreProvider>,
      );
    });
  };
  /** The turn's answer regions (one assistant turn in these frames). */
  const regions = () => qa('[data-role="assistant"] [data-testid="kit-answer"]');

  it('the early prose shows while the turn works, as the answer (not a thinking row)', async () => {
    await show(frames[1]);
    expect(regions()).toHaveLength(1);
    expect(regions()[0].textContent).toContain(fixtures.REVISED_EARLY);
    expect(regions()[0].dataset.answer).toBe('live');
    expect(regions()[0].querySelector('[data-testid="feed-text"]')).not.toBeNull();
    // The live line still says what the tools are doing, apart from the answer.
    expect(q('[data-testid="kit-thinking-live"]')).not.toBeNull();
  });

  it('the final answer replaces the early prose in the same node; one region from start to settle', async () => {
    await show(frames[0]);
    const node = regions()[0];
    expect(node.textContent).toContain(fixtures.REVISED_EARLY.slice(0, 20));
    for (const f of frames.slice(1)) {
      await show(f);
      expect(regions()).toHaveLength(1);
      expect(regions()[0]).toBe(node);
      expect(qa('[data-role="assistant"] [data-testid="feed-text"]')).toHaveLength(1);
    }
    expect(node.dataset.answer).toBe('settled');
    expect(node.textContent).toContain(fixtures.REVISED_FINAL);
  });

  it('the contradicted hypothesis is gone once the turn settles, even with the turn unfolded', async () => {
    await show(frames[3]);
    expect(container.textContent).not.toContain(fixtures.REVISED_EARLY);
    await unfold();
    expect(container.textContent).not.toContain(fixtures.REVISED_EARLY);
    expect(q('[data-testid="kit-thinking-summary"]')?.textContent).toContain('Did');
  });

  it('a reload hydrates straight into the final answer', async () => {
    // Stored parts carry no streaming state.
    const stored = frames[3].messages.map(m => ({ ...m, parts: m.parts.map(p => (p.type === 'text' ? { type: 'text', text: (p as { text: string }).text } : p)) }));
    await show({ messages: stored as Msgs, status: 'ready' });
    expect(regions().map(r => r.textContent?.trim())).toEqual([fixtures.REVISED_FINAL]);
    expect(container.textContent).not.toContain(fixtures.REVISED_EARLY);
  });

  it('an interrupted turn keeps the useful prose it had, never a blank or a cut-off stub', async () => {
    const [ask, turn] = frames[1].messages;
    const cut = { ...turn, parts: [...turn.parts, { type: 'step-start' }, { type: 'text', text: 'I chec', state: 'streaming' }, { type: 'data-turn-error', data: { code: 'aborted', message: 'Stopped.' } }] };
    await show({ messages: [ask, cut] as Msgs, status: 'ready' });
    expect(regions()).toHaveLength(1);
    expect(regions()[0].textContent).toContain(fixtures.REVISED_EARLY);
    expect(container.textContent).not.toContain('I chec');
    expect(q('[data-turn-error]')?.textContent).toBe('Stopped.');
  });

  it('an approval continuation: rationale and card hold their place, the reply is a new answer below the card', async () => {
    const messages = fixtures.chatFixture('propose').messages;
    await show({ messages, status: 'ready' });
    const turn = messages.at(-1)!;
    const asking = regions().at(-1)!;
    const card = q('[data-approval-id="approval-1"]')!;
    expect(card).not.toBeNull();
    const resumed = (state: 'streaming' | 'done') => [...messages.slice(0, -1), {
      ...turn,
      parts: [
        ...turn.parts.map(p => ((p as { approval?: { id: string } }).approval
          ? { ...p, state: 'output-available', approval: { id: (p as { approval: { id: string } }).approval.id, approved: true }, output: { summary: 'mission filed', data: {}, objects: [fixtures.missionRef] } }
          : p)),
        { type: 'step-start' },
        { type: 'text', text: 'Filed it. Planning starts now; I will post here when the first tasks are out.', state },
      ],
    }];
    await show({ messages: resumed('streaming') as Msgs, status: 'streaming' });
    const answers = qa('[data-role="assistant"]').at(-1)!.querySelectorAll<HTMLElement>('[data-testid="kit-answer"]');
    expect(answers).toHaveLength(2);
    // Nothing reparented: the rationale is the same node, still above its card, and the card is the same node.
    expect(answers[0]).toBe(asking);
    expect(answers[0].textContent).toContain('Here’s a draft.');
    expect(q('[data-approval-id="approval-1"]')).toBe(card);
    expect(card.compareDocumentPosition(answers[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(answers[1].dataset.answer).toBe('live');
    // The mission it filed is the card's receipt, between the card and the reply.
    const receipt = q('[data-kind="mission"]')!;
    expect(card.compareDocumentPosition(receipt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(receipt.compareDocumentPosition(answers[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await show({ messages: resumed('done') as Msgs, status: 'ready' });
    expect(regions().at(-1)).toBe(answers[1]);
    expect(regions().at(-1)!.textContent).toContain('Filed it.');
    expect(qa('[data-kind="mission"]')).toHaveLength(1);
  });
});

describe('a turn\'s results: grouped by what produced them, after the answer', () => {
  it('the slow sequence (interim, read, write, late card, longer final): nothing on screen moves, reparents or shows twice', async () => {
    const frames = fixtures.composedFrames();
    const views = fixtures.fixtureViews('composed');
    // The cards load only when told to: a slow network.
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const source = { load: async (r: { kind: string; id: string }) => { await gate; return views[`${r.kind}:${r.id}`]; } };
    const draw = async (f: (typeof frames)[number]) => {
      await act(async () => {
        root.render(
          <ObjectStoreProvider source={source}>
            <ChatActionsProvider value={DEFAULT_CHAT_ACTIONS}>
              <ChatFeed messages={f.messages as Msgs} agent={fixtures.ORGANIZER} status={f.status} />
            </ChatActionsProvider>
          </ObjectStoreProvider>,
        );
      });
    };
    const turn = () => qa('[data-role="assistant"]').at(-1)!;
    /** Every block on screen, in order: what must keep its node, parent and order from frame to frame. */
    const blocks = () => [...turn().querySelectorAll<HTMLElement>('.kit-msg-head, [data-testid="kit-answer"], [data-testid="feed-group"], [data-testid="object-card"]')];
    let seen: HTMLElement[] = [];
    for (const [i, f] of frames.entries()) {
      await draw(f);
      const now = blocks();
      // What was on screen is still there, under the same parent, in the same order.
      const kept = seen.filter(el => el.isConnected);
      expect(kept).toHaveLength(seen.length);
      expect(now.filter(el => kept.includes(el))).toEqual(kept);
      // One answer, ever; and no card above it while it streams.
      expect(turn().querySelectorAll('[data-testid="kit-answer"]')).toHaveLength(1);
      if (i < frames.length - 1) expect(turn().querySelector('[data-testid="object-card"]')).toBeNull();
      seen = now;
    }
    const answer = turn().querySelector('[data-testid="kit-answer"]')!;
    expect(answer.textContent).toContain(fixtures.COMPOSED_FINAL);
    expect(turn().textContent).not.toContain(fixtures.COMPOSED_EARLY);
    const groups = qa('[data-testid="feed-group"]');
    expect(groups.map(g => g.querySelector('[data-testid="feed-group-label"]')!.textContent)).toEqual(['Created · 1 task', 'Referenced · 1 task']);
    expect(groups.every(g => answer.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    // Late payloads: the shells reserve their height and then fill in place, same groups.
    const shells = qa('[data-testid="object-card"][data-state="loading"]');
    expect(shells).toHaveLength(2);
    expect(shells.every(c => c.hasAttribute('data-reserve'))).toBe(true);
    await act(async () => { release(); await gate; await new Promise(r => setTimeout(r, 0)); });
    expect(qa('[data-testid="object-card"][data-state="loading"]')).toHaveLength(0);
    expect(qa('[data-testid="feed-group"]')).toEqual(groups);
  });

  it('read: what the answer names is cited under it as one Referenced group, the rest of the list folded inside', async () => {
    await render(fixtures.chatFixture('running').messages as Msgs);
    const turn = qa('[data-role="assistant"]').at(-1)!;
    const answer = turn.querySelector('[data-testid="kit-answer"]')!;
    const group = turn.querySelector<HTMLElement>('[data-testid="feed-group"]')!;
    expect(group.dataset.group).toBe('referenced');
    expect(group.querySelector('[data-testid="feed-group-label"]')!.textContent).toBe('Referenced · 1 task');
    expect(answer.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.querySelector('[data-testid="feed-more-objects"]')).not.toBeNull();
    // Nothing from the turn sits between the work line and the answer.
    expect(qa('[data-role="assistant"] [data-testid="feed-objects"]').every(o => answer.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('a list with nothing named is just its folded row, which names itself', async () => {
    const msgs = [{ id: 'a', role: 'assistant', parts: [
      { type: 'tool-list_tasks', toolCallId: 'l1', state: 'output-available', input: {}, output: { data: [], objects: [fixtures.taskRef, fixtures.questionRef] } },
      { type: 'text', text: 'Nothing needs you.' },
    ] }] as unknown as Msgs;
    await render(msgs);
    expect(q('[data-testid="feed-group"]')).toBeNull();
    expect(q('[data-testid="feed-more-objects"]')?.textContent).toContain('Also read');
  });

  it('write many + read: each write is one Created group holding all it made; references after', async () => {
    const t = (id: string) => ({ kind: 'task', id, workspaceId: fixtures.WS.id, fallbackText: `Task ${id}` });
    const msgs = [{ id: 'a', role: 'assistant', parts: [
      { type: 'tool-get_task', toolCallId: 'g1', state: 'output-available', input: {}, output: { data: {}, objects: [fixtures.taskRef] } },
      { type: 'tool-create_task', toolCallId: 'c1', state: 'output-available', input: {}, output: { data: {}, objects: [t('n1'), t('n2')] } },
      { type: 'text', text: 'Filed two follow-ups for the rates service.' },
    ] }] as unknown as Msgs;
    await render(msgs);
    const groups = qa('[data-testid="feed-group"]');
    expect(groups.map(g => [g.dataset.group, g.querySelector('[data-testid="feed-group-label"]')!.textContent])).toEqual([
      ['created', 'Created · 2 tasks'], ['referenced', 'Referenced · 1 task'],
    ]);
    expect(groups[0].querySelectorAll('[data-testid="object-card"]')).toHaveLength(2);
    expect(groups[0].getAttribute('aria-label')).toBe('Created: 2 tasks');
  });

  it('a re-render with the same parts (reconnect) draws every card once, in the same nodes', async () => {
    const msgs = fixtures.chatFixture('running').messages as Msgs;
    const views = fixtures.fixtureViews('running');
    const source = { load: async (r: { kind: string; id: string }) => views[`${r.kind}:${r.id}`] };
    const draw = async (messages: Msgs) => {
      await act(async () => {
        root.render(
          <ObjectStoreProvider source={source}>
            <ChatActionsProvider value={DEFAULT_CHAT_ACTIONS}>
              <ChatFeed messages={messages} agent={fixtures.ORGANIZER} />
            </ChatActionsProvider>
          </ObjectStoreProvider>,
        );
      });
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    };
    await draw(msgs);
    const before = qa('[data-testid="feed-group"], [data-testid="object-card"]');
    await draw(msgs.map(m => ({ ...m, parts: [...m.parts] })) as Msgs);
    const after = qa('[data-testid="feed-group"], [data-testid="object-card"]');
    expect(after).toHaveLength(before.length);
    expect(after.every((el, i) => el === before[i])).toBe(true);
  });

  it('the agent\'s header is drawn while the turn streams, so landing adds nothing above the answer', async () => {
    const streaming = fixtures.chatFixture('streaming');
    await act(async () => {
      root.render(
        <ObjectStoreProvider source={{ load: async () => { throw new Error('Not found'); } }}>
          <ChatActionsProvider value={DEFAULT_CHAT_ACTIONS}>
            <ChatFeed messages={streaming.messages as Msgs} agent={fixtures.ORGANIZER} status="streaming" />
          </ChatActionsProvider>
        </ObjectStoreProvider>,
      );
    });
    const turn = qa('[data-role="assistant"]').at(-1)!;
    expect(turn.querySelector('.kit-msg-head')?.textContent).toContain('buildd');
  });
});
