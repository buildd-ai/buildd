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
