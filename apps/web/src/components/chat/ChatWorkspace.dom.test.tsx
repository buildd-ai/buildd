/**
 * The chat canvas, mounted (happy-dom): the scan line runs only while a turn
 * streams, the empty canvas greets and offers one-tap questions, the mission
 * the chat is about pins as a compact live board, and keyboard hints stay
 * hidden unless the person turned them on.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/chat' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => '/app/chat',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ChatWorkspace } = await import('./ChatWorkspace');
const { ObjectStoreProvider } = await import('./objects/ObjectStoreProvider');
const { KeyHintsProvider } = await import('@/components/KeyHints');
const fixtures = await import('../../app/app/dev/chat/chat-fixtures');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const sent: string[] = [];

beforeEach(() => {
  (window as any).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sent.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Props = Parameters<typeof ChatWorkspace>[0];

async function render(over: Partial<Props> = {}, opts: { hints?: boolean; state?: Parameters<typeof fixtures.fixtureViews>[0] } = {}) {
  const views = fixtures.fixtureViews(opts.state ?? 'split');
  const source = { load: async (r: { kind: string; id: string }) => { const v = views[`${r.kind}:${r.id}`]; if (!v) throw new Error('Not found'); return v; } };
  const props: Props = {
    messages: [], status: 'ready', onSend: (t: string) => { sent.push(t); }, onApproval() {},
    title: null, agent: fixtures.ORGANIZER, tier: 'standard', workspaces: fixtures.WORKSPACES,
    workspaceId: fixtures.WS.id, onWorkspaceChange() {}, viewerName: 'Maya', ...over,
  };
  await act(async () => {
    root.render(
      <KeyHintsProvider value={opts.hints ?? false}>
        <ObjectStoreProvider source={source}>
          <ChatWorkspace {...props} />
        </ObjectStoreProvider>
      </KeyHintsProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[];

describe('scan line', () => {
  it('runs along the top edge only while a turn is in flight', async () => {
    const msgs = fixtures.chatFixture('streaming').messages;
    await render({ messages: msgs, status: 'streaming' });
    expect(q('[data-testid="canvas-scan"]')).not.toBeNull();
    await render({ messages: msgs, status: 'submitted' });
    expect(q('[data-testid="canvas-scan"]')).not.toBeNull();
    await render({ messages: msgs, status: 'ready' });
    expect(q('[data-testid="canvas-scan"]')).toBeNull();
  });
});

describe('empty canvas', () => {
  const labels = () => qa('[data-testid="canvas-suggestion-label"]').map(c => c.textContent);
  const placeholder = () => (q('#chat-composer-input') as HTMLTextAreaElement).placeholder;

  it('without a pulse: greets by name, claims no mood, and offers no needs-you prompt', async () => {
    await render();
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('Hi Maya, what are we working on?');
    expect(q('[data-testid="canvas-mood-dot"]')).toBeNull();
    expect(labels()).toEqual(["What's running right now?", 'Start something new']);
    await act(async () => { qa('[data-testid="canvas-suggestion"]')[0].click(); });
    expect(sent).toEqual(["What's running right now?"]);
  });

  it('calm: all quiet, exactly two picked rows, nothing copper, the top row is the placeholder', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    expect(q('[data-testid="canvas-empty"]')?.dataset.mood).toBe('calm');
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('All quiet.');
    expect(q('[data-testid="canvas-picked-status"]')?.textContent).toBe('nothing blocked');
    expect(qa('[data-testid="canvas-suggestion"]')).toHaveLength(2);
    expect(qa('[data-testid="canvas-suggestion"][data-tone="needs"]')).toHaveLength(0);
    expect(placeholder()).toBe('Start something new…');
    expect(q('[data-testid="chat-composer"]')?.dataset.mood).toBe('calm');
  });

  it('needs you: names it, row 1 is copper, the composer rule turns copper', async () => {
    await render({ pulse: { needsYou: [{ title: 'Pick a currency' }], live: 1 } });
    expect(q('[data-testid="canvas-empty"]')?.dataset.mood).toBe('needs');
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('One thing needs you.');
    expect(q('[data-testid="canvas-picked-status"]')?.textContent).toBe('1 blocked');
    const rows = qa('[data-testid="canvas-suggestion"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.tone).toBe('needs');
    expect(placeholder()).toBe('What does “Pick a currency” need from me?');
    expect(q('[data-testid="chat-composer"]')?.dataset.mood).toBe('needs');
    await act(async () => { rows[0].click(); });
    expect(sent).toEqual(['What does "Pick a currency" need from me?']);
  });

  it('a starter fills the box instead of sending', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    const starter = qa('[data-testid="canvas-suggestion"]').find(c => c.textContent?.includes('Start something new'))!;
    await act(async () => { starter.click(); });
    expect(sent).toEqual([]);
    expect((q('#chat-composer-input') as HTMLTextAreaElement).value).toBe('I want to build ');
  });
});

describe('pinned object', () => {
  it('the mission the chat is about pins as a compact board', async () => {
    await render({ focusRef: fixtures.missionRef, focusOpensSheet: false, initialPaneClosed: true });
    const pin = q('[data-testid="canvas-pinned"]');
    expect(pin?.dataset.kind).toBe('mission');
    expect(qa('[data-testid="canvas-mini-row"]').length).toBeGreaterThan(0);
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('Ask anything about');
  });

  it('no object in the conversation: nothing pinned', async () => {
    await render();
    expect(q('[data-testid="canvas-pinned"]')).toBeNull();
  });
});

describe('keyboard hints', () => {
  it('are hidden by default and shown when turned on', async () => {
    await render();
    expect(q('[data-testid="composer-key-hints"]')).toBeNull();
    expect(q('[data-testid="key-hint"]')).toBeNull();
    await render({}, { hints: true });
    expect(q('[data-testid="composer-key-hints"]')).not.toBeNull();
  });
});
