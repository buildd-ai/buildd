/**
 * RealTimeWorkerView in a browser (happy-dom). Regression (UX review, task
 * page with a question): the global "…needs your input" banner sat above the
 * question hero naming the same question. While the page shows its own
 * question, the banner skips it. Runs in its own process
 * (scripts/run-unit-tests.ts), so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/task-1' });

import { describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
mock.module('@/lib/pusher-client', () => ({
  subscribeToChannel: () => null,
  unsubscribeFromChannel: () => {},
  getSubscribedChannel: () => null,
  CHANNEL_PREFIX: 'buildd-',
}));

const { default: RealTimeWorkerView } = await import('./RealTimeWorkerView');
const { hiddenNeedsInputSnapshot } = await import('@/lib/needs-input-hidden');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function worker(waitingFor: unknown) {
  return {
    id: 'worker-1', name: 'w', branch: 'buildd/x', status: waitingFor ? 'waiting_input' : 'running',
    currentAction: null, milestones: [], turns: 3, costUsd: null, inputTokens: 0, outputTokens: 0,
    startedAt: null, prUrl: null, prNumber: null, localUiUrl: null, commitCount: null, filesChanged: null,
    linesAdded: null, linesRemoved: null, lastCommitSha: null, waitingFor,
    instructionHistory: [], pendingInstructions: null, updatedAt: '2026-09-23T00:00:00.000Z',
  };
}

async function mount(w: ReturnType<typeof worker>) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<RealTimeWorkerView initialWorker={w as any} taskId="task-1" nowMs={0} />); });
  return async () => { await act(async () => root.unmount()); el.remove(); };
}

describe('RealTimeWorkerView and the needs-input banner', () => {
  it('hides the banner for this task while its question is on screen, and releases it on unmount', async () => {
    const unmount = await mount(worker({ type: 'question', prompt: 'Round per line, or only the total?', options: ['Per line', 'Total'] }));
    expect(hiddenNeedsInputSnapshot().has('task-1')).toBe(true);
    await unmount();
    expect(hiddenNeedsInputSnapshot().has('task-1')).toBe(false);
  });

  it('leaves the banner alone while the agent is just running', async () => {
    const unmount = await mount(worker(null));
    expect(hiddenNeedsInputSnapshot().has('task-1')).toBe(false);
    await unmount();
  });
});
