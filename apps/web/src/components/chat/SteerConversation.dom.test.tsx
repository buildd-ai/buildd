/**
 * The Steer canvas, mounted (happy-dom): the kit's SteerComposer over buildd's
 * instruct route. Sends go straight to the worker's instruction queue (not a
 * chat turn), each message's status reads sent → delivered, only a caller
 * who may send gets a composer, and the presence strip names the runner.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/11111111-1111-4111-8111-111111111111' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SteerConversation } = await import('./SteerConversation');

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let posted: Array<{ url: string; body: unknown }>;
let messagesResponse: { workerId: string | null; canSend: boolean; messages: unknown[] };

beforeEach(() => {
  posted = [];
  messagesResponse = { workerId: WORKER_ID, canSend: true, messages: [] };
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/tasks/') && u.endsWith('/messages')) {
      return new Response(JSON.stringify({ taskId: TASK_ID, ...messagesResponse }), { status: 200 });
    }
    if (u.startsWith('/api/workers/') && u.endsWith('/instruct')) {
      posted.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true, message: 'sent', deliveryState: 'pending' }), { status: 200 });
    }
    if (u.startsWith('/api/objects/task/')) {
      return new Response(JSON.stringify({ error: 'not needed for these assertions' }), { status: 404 });
    }
    return new Response(JSON.stringify({ error: 'unexpected fetch: ' + u }), { status: 500 });
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });

// React tracks a controlled input's value through a hidden property setter; a
// plain `.value = ` assignment doesn't trip its change detection, so the
// dispatched 'input' event is a no-op and onChange never fires. Go through
// the native setter, the standard React-testing workaround, instead.
function typeInto(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function render() {
  await act(async () => {
    root.render(<SteerConversation taskId={TASK_ID} onClose={() => {}} />);
  });
  await settle();
}

describe('SteerConversation — send', () => {
  it('sends through POST /api/workers/[id]/instruct with priority urgent, not a chat turn', async () => {
    await render();
    const textarea = q('[data-testid="kit-steer-input"]') as HTMLTextAreaElement;
    await act(async () => { typeInto(textarea, 'Stop and check the rounding'); });
    await settle();
    (q('[data-testid="kit-steer-send"]') as HTMLButtonElement).click();
    await settle();

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe(`/api/workers/${WORKER_ID}/instruct`);
    expect(posted[0].body).toEqual({ message: 'Stop and check the rounding', priority: 'urgent' });
  });

  it('the composer is disabled with no worker to send to', async () => {
    messagesResponse = { workerId: null, canSend: true, messages: [] };
    await render();
    const textarea = q('[data-testid="kit-steer-input"]') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it('a member who can read but not send gets a disabled composer that says why', async () => {
    messagesResponse = { workerId: WORKER_ID, canSend: false, messages: [] };
    await render();
    const textarea = q('[data-testid="kit-steer-input"]') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toBe('Only workspace admins can steer this agent.');
  });
});

describe('SteerConversation — message status', () => {
  it('shows sent and delivered from the task\'s own messages, and never a turn-based read', async () => {
    messagesResponse = {
      workerId: WORKER_ID,
      canSend: true,
      messages: [
        { type: 'instruction', message: 'still queued', timestamp: 1 },
        { type: 'instruction', message: 'runner has it', timestamp: 2, deliveryState: 'delivered', turnAtSend: 6 },
      ],
    };
    await render();
    const rows = Array.from(container.querySelectorAll('[data-testid="kit-steer-message"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-status')).toBe('sent');
    expect(rows[0].textContent).toContain('Sent');
    expect(rows[1].getAttribute('data-status')).toBe('delivered');
    expect(rows[1].textContent).toContain('Delivered');
    expect(container.textContent).not.toContain('Read at turn');
    expect(container.querySelector('[data-testid="steer-turn"]')).toBeNull();
  });

  it('shows read and not-delivered from the server-derived state', async () => {
    messagesResponse = {
      workerId: WORKER_ID,
      canSend: true,
      workerStatus: 'completed',
      messages: [
        { id: 'a', type: 'instruction', message: 'it read this', timestamp: 1, deliveryState: 'acknowledged', state: 'acknowledged' },
        { id: 'b', type: 'instruction', message: 'run ended first', timestamp: 2, deliveryState: 'pending', state: 'undelivered' },
      ],
    };
    await render();
    const rows = Array.from(container.querySelectorAll('[data-testid="kit-steer-message"]'));
    expect(rows.map(r => r.getAttribute('data-status'))).toEqual(['acknowledged', 'undelivered']);
    expect(rows[0].textContent).toContain('Read');
    expect(rows[1].textContent).toContain('Not delivered');
  });
});
