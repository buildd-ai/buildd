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
});
