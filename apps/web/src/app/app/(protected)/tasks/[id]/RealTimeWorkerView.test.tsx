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

const { default: RealTimeWorkerView, shouldFlushImmediately, parseErrorMessage } = await import(
  './RealTimeWorkerView'
);

function baseWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: 'worker-1',
    name: 'Test Worker',
    branch: 'buildd/test',
    status: 'waiting_input',
    currentAction: null,
    milestones: [],
    turns: 3,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: null,
    prUrl: null,
    prNumber: null,
    localUiUrl: null,
    commitCount: null,
    filesChanged: null,
    linesAdded: null,
    linesRemoved: null,
    lastCommitSha: null,
    waitingFor: null,
    instructionHistory: [],
    pendingInstructions: null,
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

function render(worker: ReturnType<typeof baseWorker>) {
  return renderToStaticMarkup(
    <RealTimeWorkerView initialWorker={worker as any} taskId="task-1" />,
  );
}

describe('RealTimeWorkerView — needs-input answering', () => {
  test('waiting_input with no options renders the free-text box, not an options list', () => {
    const html = render(
      baseWorker({ status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Which approach?', options: [] } }),
    );
    expect(html).toContain('worker-needs-input-freetext');
    expect(html).not.toContain('worker-needs-input-options');
  });

  test('options present renders both the options list and the free-text box', () => {
    const html = render(
      baseWorker({
        status: 'waiting_input',
        waitingFor: { type: 'question', prompt: 'Pick one', options: ['A', 'B'] },
      }),
    );
    expect(html).toContain('worker-needs-input-options');
    expect(html).toContain('worker-needs-input-freetext');
  });

  test('error status with an unanswered question renders the answer box but no InstructWorkerForm', () => {
    const html = render(
      baseWorker({ status: 'error', waitingFor: { type: 'question', prompt: 'Now what?', options: [] } }),
    );
    expect(html).toContain('worker-needs-input-freetext');
    expect(html).not.toContain('worker-instruct-form');
  });

  test('waiting_input with an unanswered question also hides InstructWorkerForm', () => {
    const html = render(
      baseWorker({ status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Now what?', options: [] } }),
    );
    expect(html).not.toContain('worker-instruct-form');
  });

  test('an active worker with no pending question still shows InstructWorkerForm', () => {
    const html = render(baseWorker({ status: 'running', waitingFor: null }));
    expect(html).toContain('worker-instruct-form');
  });

  test('worker-needs-input-banner testid survives unchanged', () => {
    const html = render(
      baseWorker({ status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Hi', options: [] } }),
    );
    expect(html).toContain('worker-needs-input-banner');
  });
});

describe('shouldFlushImmediately', () => {
  test('a status change flushes immediately', () => {
    expect(shouldFlushImmediately('running', 'waiting_input')).toBe(true);
  });

  test('the same status repeated is debounced, not flushed', () => {
    expect(shouldFlushImmediately('running', 'running')).toBe(false);
  });

  test('a missing status on the event is debounced, not flushed', () => {
    expect(shouldFlushImmediately('running', undefined)).toBe(false);
  });
});

describe('parseErrorMessage', () => {
  test('extracts the server error field from a JSON error body', async () => {
    const res = new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    expect(await parseErrorMessage(res, 'Failed to abort')).toBe('boom');
  });

  test('falls back on a non-JSON body instead of throwing', async () => {
    const res = new Response('not json', { status: 500 });
    expect(await parseErrorMessage(res, 'Failed to abort')).toBe('Failed to abort');
  });

  test('falls back when the JSON body has no error field', async () => {
    const res = new Response(JSON.stringify({ ok: false }), { status: 500 });
    expect(await parseErrorMessage(res, 'Failed to abort')).toBe('Failed to abort');
  });
});
