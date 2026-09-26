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

async function render(messages: Msgs, state: Parameters<typeof fixtures.fixtureViews>[0] = 'split') {
  const views = fixtures.fixtureViews(state);
  const source = { load: async (r: { kind: string; id: string }) => { const v = views[`${r.kind}:${r.id}`]; if (!v) throw new Error('Not found'); return v; } };
  const actions = {
    ...DEFAULT_CHAT_ACTIONS,
    respondToApproval: (id: string, ok: boolean) => { calls.push([id, ok]); },
    answerQuestion: async (i: { workerId: string; message: string }) => { answers.push(i); },
    viewerName: 'Maya',
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

describe('approval card', () => {
  it('Confirm echoes the approval id back, once; the buttons then lock', async () => {
    await render(fixtures.chatFixture('propose').messages as Msgs);
    const card = q('[data-testid="approval-card"]');
    expect(card?.dataset.state).toBe('awaiting');
    expect(card?.textContent).toContain('manage_missions · create');
    expect(card?.textContent).toContain('not filed');
    await act(async () => { q('[data-testid="approval-confirm"]')!.click(); });
    await act(async () => { q('[data-testid="approval-confirm"]')!.click(); });
    expect(calls).toEqual([['approval-1', true]]);
    expect((q('[data-testid="approval-deny"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Discard answers false', async () => {
    await render(fixtures.chatFixture('propose').messages as Msgs);
    await act(async () => { q('[data-testid="approval-deny"]')!.click(); });
    expect(calls).toEqual([['approval-1', false]]);
  });

  it('a denied proposal files nothing and says so', async () => {
    await render(fixtures.chatFixture('denied').messages as Msgs);
    expect(q('[data-testid="approval-card"]')?.dataset.state).toBe('denied');
    expect(q('[data-testid="approval-card"]')?.textContent).toContain('nothing filed');
    expect(q('[data-testid="approval-confirm"]')).toBeNull();
    expect(q('[data-kind="mission"]')).toBeNull();
  });

  it('once filed, the card is its tool row and the live mission renders under it', async () => {
    await render(fixtures.chatFixture('confirmed').messages as Msgs, 'confirmed');
    expect(q('[data-testid="approval-confirm"]')).toBeNull();
    const row = qa('[data-testid="tool-call-row"]').find(r => r.dataset.tool === 'manage_missions' && r.textContent?.includes('approved by Maya'));
    expect(row?.dataset.state).toBe('done');
    expect(q('[data-testid="object-card"][data-kind="mission"]')?.textContent).toContain('Multi-currency invoices');
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

  it('a run of PRs stacks as one list', async () => {
    await render(fixtures.chatFixture('shipped').messages as Msgs, 'shipped');
    expect(q('[data-testid="pr-list"]')?.textContent).toContain('7 pull requests');
    expect(qa('[data-testid="object-card"][data-kind="pr"]').length).toBe(7);
  });
});
