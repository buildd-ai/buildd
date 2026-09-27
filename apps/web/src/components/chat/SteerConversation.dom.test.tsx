/**
 * The Steer canvas, mounted (happy-dom): sends go straight to the worker's
 * instruction queue (not a chat turn), and each message's status reads
 * sent → delivered → read at turn N.
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
let messagesResponse: { workerId: string | null; turns: number | null; messages: unknown[] };

beforeEach(() => {
  posted = [];
  messagesResponse = { workerId: WORKER_ID, turns: 5, messages: [] };
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
    const textarea = q('#steer-composer-input') as HTMLTextAreaElement;
    await act(async () => { typeInto(textarea, 'Stop and check the rounding'); });
    await settle();
    (q('[data-testid="steer-send"]') as HTMLButtonElement).click();
    await settle();

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe(`/api/workers/${WORKER_ID}/instruct`);
    expect(posted[0].body).toEqual({ message: 'Stop and check the rounding', priority: 'urgent' });
  });

  it('the composer is disabled with no worker to send to', async () => {
    messagesResponse = { workerId: null, turns: null, messages: [] };
    await render();
    const textarea = q('#steer-composer-input') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });
});

describe('SteerConversation — message status', () => {
  it('shows sent, delivered, and read at turn N from the task\'s own messages', async () => {
    messagesResponse = {
      workerId: WORKER_ID,
      turns: 8,
      messages: [
        { type: 'instruction', message: 'still queued', timestamp: 1 },
        { type: 'instruction', message: 'runner has it', timestamp: 2, deliveryState: 'delivered', turnAtSend: 8 },
        { type: 'instruction', message: 'agent turned since', timestamp: 3, deliveryState: 'delivered', turnAtSend: 6 },
      ],
    };
    await render();
    const rows = Array.from(container.querySelectorAll('[data-testid="steer-message"]'));
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('data-status')).toBe('sent');
    expect(rows[0].textContent).toContain('Sent');
    expect(rows[1].getAttribute('data-status')).toBe('delivered');
    expect(rows[1].textContent).toContain('Delivered');
    expect(rows[2].getAttribute('data-status')).toBe('read');
    expect(rows[2].textContent).toContain('Read at turn 7');
  });
});
