import { describe, test, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

mock.module('@/lib/pusher-client', () => ({
  subscribeToChannel: () => null,
  unsubscribeFromChannel: () => {},
  getSubscribedChannel: () => null,
  CHANNEL_PREFIX: 'buildd-',
}));

const { default: WorkerSteerPanel } = await import('./WorkerSteerPanel');

const render = (props: Partial<Parameters<typeof WorkerSteerPanel>[0]>) =>
  renderToStaticMarkup(
    <WorkerSteerPanel workerId="w1" status="running" hasUnansweredQuestion={false} instructionHistory={[]} {...props} />,
  );

describe('WorkerSteerPanel — message delivery states (B-12)', () => {
  const history = [
    { id: 'a', type: 'instruction' as const, message: 'queued one', timestamp: 1, deliveryState: 'pending' as const },
    { id: 'b', type: 'instruction' as const, message: 'in session', timestamp: 2, deliveryState: 'delivered' as const, deliveredAt: 3, awaitsAck: true as const },
    { id: 'c', type: 'instruction' as const, message: 'was read', timestamp: 4, deliveryState: 'acknowledged' as const, acknowledgedAt: 5 },
    { type: 'response' as const, message: 'ok', timestamp: 6 },
  ];

  test('every human message shows its state as text, not colour alone', () => {
    const html = render({ instructionHistory: history });
    expect(html).toContain('data-state="queued"');
    expect(html).toContain('data-state="delivered"');
    expect(html).toContain('data-state="acknowledged"');
    expect(html).toContain('Queued');
    expect(html).toContain('Delivered');
    expect(html).toContain('Read by the agent');
    // The agent's own reply carries no delivery chip.
    expect((html.match(/data-testid="message-delivery-state"/g) ?? []).length).toBe(3);
    expect(html).not.toContain('Pending delivery');
  });

  test('undelivered messages from the earlier run show Not delivered and a 44px Resend', () => {
    const html = render({
      earlierRun: {
        workerId: 'w0',
        status: 'failed',
        history: [{ id: 'z', type: 'instruction' as const, message: 'never read', timestamp: 1, deliveryState: 'pending' as const }],
      },
    });
    expect(html).toContain('data-testid="earlier-run-undelivered"');
    expect(html).toContain('data-state="undelivered"');
    expect(html).toContain('Not delivered');
    expect(html).toContain('never read');
    expect(html).toContain('data-testid="message-resend"');
    expect(html).toMatch(/data-testid="message-resend"[^>]*min-h-11|min-h-11[^>]*data-testid="message-resend"/);
  });

  test('no earlier-run section when nothing was left undelivered', () => {
    const html = render({
      earlierRun: {
        workerId: 'w0',
        status: 'completed',
        history: [{ id: 'z', type: 'instruction' as const, message: 'read', timestamp: 1, deliveryState: 'acknowledged' as const, acknowledgedAt: 2 }],
      },
    });
    expect(html).not.toContain('earlier-run-undelivered');
  });
});

describe('WorkerSteerPanel', () => {
  test('an active worker with no pending question shows the steer form and stop', () => {
    const html = render({});
    expect(html).toContain('worker-instruct-form');
    expect(html).toContain('Steer this agent');
    expect(html).toContain('worker-abort-btn');
  });

  test('an unanswered question hides the steer form (the answer path is /respond)', () => {
    const html = render({ status: 'waiting_input', hasUnansweredQuestion: true });
    expect(html).not.toContain('worker-instruct-form');
  });

  test('renders nothing for a finished worker', () => {
    expect(render({ status: 'completed' })).toBe('');
  });

  test('a runner-backed worker keeps Stop agent and has no Release slot', () => {
    const html = render({ runner: 'runner-abc' });
    expect(html).toContain('worker-abort-btn');
    expect(html).toContain('Stop agent');
    expect(html).not.toContain('worker-release-slot-btn');
  });

  test('a local session offers Release slot instead of Stop agent, and says it cannot stop it', () => {
    const html = render({ runner: 'mcp' });
    expect(html).toContain('worker-release-slot-btn');
    expect(html).toContain('Release slot');
    expect(html).not.toContain('worker-abort-btn');
    expect(html).not.toContain('Stop agent');
    expect(html).toContain('can’t stop it');
  });

  test('a local session on an ended task: Release slot is the primary action, no steering', () => {
    const html = render({ runner: 'mcp', taskTerminal: true });
    expect(html).toContain('worker-release-slot-btn');
    expect(html).toContain('border-2');
    expect(html).toContain('Task ended');
    expect(html).not.toContain('worker-instruct-form');
  });

  test('an idle local session still holds a slot, so it still gets Release slot', () => {
    expect(render({ runner: 'mcp', status: 'idle' })).toContain('worker-release-slot-btn');
  });
});
