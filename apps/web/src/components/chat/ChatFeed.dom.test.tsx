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
    expect(head.querySelector('.kit-eyebrow')?.textContent).toBe('Needs your OK');
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

  it('while a turn streams, the Thinking panel shows the server\'s steps, in plain words', async () => {
    await act(async () => {
      root.render(<ChatFeed messages={fixtures.chatFixture('streaming').messages as Msgs} agent={fixtures.ORGANIZER} status="streaming" />);
    });
    const steps = qa('.kit-step');
    expect(steps.map(s => [stepText(s), s.dataset.state])).toEqual([
      ['Looked over the missions', 'done'],
      ['Searching what buildd remembers', 'active'],
    ]);
    expect(container.textContent).not.toContain('recall');
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
    expect(qa('.kit-step').map(stepText)).toEqual(['Read a task', 'Thinking it through']);
  });

  it('a settled turn shows no panel', async () => {
    await act(async () => {
      root.render(<ChatFeed messages={fixtures.chatFixture('streaming').messages as Msgs} agent={fixtures.ORGANIZER} status="ready" />);
    });
    expect(qa('.kit-step')).toHaveLength(0);
  });

  it('a call still in flight reads as running', async () => {
    await render(fixtures.chatFixture('streaming').messages as Msgs);
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

    expect(notices[1].querySelector('p.font-voice')?.textContent).toBe('Dual-currency CSV needs your answer.');
    expect((notices[1].querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe('/app/tasks/task-export');
    expect(notices[2].querySelector('p.font-voice')?.textContent).toBe('CI failed on #421.');

    // The watch's own tool row is square too (v3 foreground), not a pill.
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
