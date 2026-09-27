/**
 * Thumbs on an assistant turn, mounted (happy-dom): a thumbs-down records at
 * once and opens the five reasons; Send records the reason label; the same
 * thumb again toggles off; a still-streaming turn shows no thumbs.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/chat' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TurnFeedback, TurnFeedbackProvider } = await import('./TurnFeedback');

const MSG = '0f6c2a10-0000-4000-8000-00000000c0de';
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const posts: any[] = [];

beforeEach(() => {
  posts.length = 0;
  (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ feedback: {} }), { status: 200 });
  };
  // Desktop: the reasons open as a popover.
  (window as any).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(pendingId: string | null = null) {
  await act(async () => {
    root.render(createElement(TurnFeedbackProvider, { messageIds: [MSG], pendingId, initial: {} },
      createElement(TurnFeedback, { messageId: MSG })));
  });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };

describe('TurnFeedback', () => {
  it('a thumbs-up records at once', async () => {
    await mount();
    await click(q('turn-feedback-up'));
    expect(posts).toEqual([{ entityType: 'conversation_message', entityId: MSG, signal: 'up' }]);
    expect(q('turn-feedback')!.dataset.vote).toBe('up');
  });

  it('a thumbs-down records, offers the five reasons, and Send records the label', async () => {
    await mount();
    await click(q('turn-feedback-down'));
    expect(posts[0]).toEqual({ entityType: 'conversation_message', entityId: MSG, signal: 'down' });
    const reasons = [...container.querySelectorAll('[data-testid="turn-feedback-reason"]')].map(e => e.textContent);
    expect(reasons).toEqual(['Wrong answer', 'Wrong action', 'Made something up', 'Ignored what I said', 'Too slow']);
    await click(container.querySelector('[data-reason="made_up"]'));
    await click(q('turn-feedback-send'));
    expect(posts[1]).toEqual({ entityType: 'conversation_message', entityId: MSG, signal: 'down', reason: 'made_up' });
    expect(q('turn-feedback-sheet')).toBeNull();
    expect(q('turn-feedback')!.dataset.reason).toBe('made_up');
  });

  it('Skip closes without a reason', async () => {
    await mount();
    await click(q('turn-feedback-down'));
    await click(q('turn-feedback-skip'));
    expect(posts).toHaveLength(1);
    expect(q('turn-feedback-sheet')).toBeNull();
    expect(q('turn-feedback')!.dataset.vote).toBe('down');
  });

  it('the same thumb again toggles it off', async () => {
    await mount();
    await click(q('turn-feedback-up'));
    await click(q('turn-feedback-up'));
    expect(posts).toHaveLength(2);
    expect(q('turn-feedback')!.dataset.vote).toBe('');
  });

  it('a turn still streaming has no thumbs', async () => {
    await mount(MSG);
    expect(q('turn-feedback')).toBeNull();
  });
});
