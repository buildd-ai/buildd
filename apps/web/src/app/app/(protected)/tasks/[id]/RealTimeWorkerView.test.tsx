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

const { default: RealTimeWorkerView, shouldFlushImmediately, parseErrorMessage, elapsedLabel } = await import(
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

  test('error status with an unanswered question still renders the answer box', () => {
    const html = render(
      baseWorker({ status: 'error', waitingFor: { type: 'question', prompt: 'Now what?', options: [] } }),
    );
    expect(html).toContain('worker-needs-input-freetext');
  });

  test('worker-needs-input-banner testid survives unchanged', () => {
    const html = render(
      baseWorker({ status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Hi', options: [] } }),
    );
    expect(html).toContain('worker-needs-input-banner');
  });

  test('object options keep their description and recommended flag', () => {
    const html = render(
      baseWorker({
        status: 'waiting_input',
        waitingFor: { type: 'question', prompt: 'Pick', options: [{ label: 'A', description: 'does a' }, { label: 'B', recommended: true }] },
      }),
    );
    expect(html).toContain('does a');
    expect(html.match(/data-recommended="true"/g)?.length).toBe(1);
  });

  test('a linked question note supplies the headline and marks its default choice recommended', () => {
    const html = renderToStaticMarkup(
      <RealTimeWorkerView
        taskId="task-1"
        roleName="Builder"
        nowMs={Date.parse('2026-09-23T00:00:10.000Z')}
        questionNote={{ id: 'n1', workerId: 'worker-1', type: 'question', status: 'open', title: 'Round per line?', body: null, defaultChoice: 'Per line', createdAt: '2026-09-23T00:00:03.000Z' }}
        initialWorker={baseWorker({ status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Long prompt text', options: ['Per line', 'Total only'] } }) as any}
      />,
    );
    expect(html).toContain('Round per line?');
    expect(html).toContain('The builder asks');
    expect(html).toContain('7s ago');
    expect(html.match(/data-recommended="true"/g)?.length).toBe(1);
    expect(html.indexOf('data-recommended="true"')).toBeLessThan(html.indexOf('Total only'));
    // One question surface, not two.
    expect(html.match(/data-testid="worker-needs-input-prompt"/g)?.length).toBe(1);
  });

  test('the waiting state shows where it paused instead of the live Now strip', () => {
    const html = render(
      baseWorker({
        status: 'waiting_input',
        waitingFor: { type: 'question', prompt: 'Q', options: [] },
        milestones: [{ type: 'status', label: 'Rounding differs', progress: 40, ts: 1 }],
      }),
    );
    expect(html).toContain('worker-paused-bar');
    expect(html).toContain('Paused at');
    expect(html).toContain('Rounding differs');
    expect(html).not.toContain('worker-now-strip');
  });
});

describe('RealTimeWorkerView — running', () => {
  const T0 = Date.parse('2026-09-23T00:00:00.000Z');
  const running = baseWorker({
    status: 'running',
    startedAt: new Date(T0).toISOString(),
    turns: 19,
    inputTokens: 190_000,
    outputTokens: 7_600,
    milestones: [
      { type: 'checkpoint', event: 'session_started', label: 'Session started', ts: T0 },
      { type: 'status', label: 'PDF footnote: base amount and the rate used', progress: 45, ts: T0 + 200_000 },
      { type: 'action', label: 'Wrote Footnote.tsx', tool: 'Write', path: 'packages/pdf/src/Footnote.tsx', add: 42, rem: 0, ts: T0 + 250_000 },
    ],
  });

  test('renders the Now strip hero with the latest progress, the stat row and the activity', () => {
    const html = renderToStaticMarkup(<RealTimeWorkerView initialWorker={running as any} taskId="task-1" nowMs={T0 + 261_000} />);
    expect(html).toContain('worker-now-strip');
    expect(html).toContain('PDF footnote: base amount and the rate used');
    expect(html).toContain('worker-progress-bar');
    expect(html).toContain('worker-current-action');
    expect(html).toContain('worker-stats');
    expect(html).toContain('4:21');
    expect(html).toContain('197.6');
    expect(html).toContain('worker-activity-timeline');
    expect(html).toContain('Footnote.tsx');
  });

  test('no cost tile, even on an API-key account with a cost', () => {
    const html = renderToStaticMarkup(
      <RealTimeWorkerView initialWorker={{ ...running, costUsd: '0.71', account: { authType: 'api' } } as any} taskId="task-1" nowMs={T0 + 261_000} />,
    );
    expect(html).not.toContain('0.71');
    expect(html).not.toMatch(/>Cost</i);
  });

  test('the PR tile replaces files touched once a PR exists and keeps worker-pr-link', () => {
    const html = renderToStaticMarkup(
      <RealTimeWorkerView initialWorker={{ ...running, prUrl: 'https://example.test/pull/7', prNumber: 7, prLifecycleStatus: 'ci_running' } as any} taskId="task-1" nowMs={T0 + 261_000} />,
    );
    expect(html).toContain('worker-pr-link');
    expect(html).toContain('#7');
    expect(html).toContain('CI running');
    expect(html).not.toContain('worker-stat-files');
  });

  test('instructions are not rendered here any more (they live in the side panel)', () => {
    const html = renderToStaticMarkup(<RealTimeWorkerView initialWorker={running as any} taskId="task-1" nowMs={T0 + 261_000} />);
    expect(html).not.toContain('worker-instruct-form');
  });
});

describe('elapsedLabel', () => {
  test('clock under ten hours, compact units beyond', () => {
    expect(elapsedLabel(261_000)).toBe('4:21');
    expect(elapsedLabel(11 * 3_600_000)).toBe('11h');
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
