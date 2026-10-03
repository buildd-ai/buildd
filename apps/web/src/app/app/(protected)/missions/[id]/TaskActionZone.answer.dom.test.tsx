/**
 * The mission task sheet's answer, mounted (happy-dom). The live bug: a tapped
 * option showed no pending state and no confirmation (the sheet reads a client
 * fetch, so the old `router.refresh()` changed nothing), and the second tap
 * came back "already answered" as an error.
 *
 * - the tapped chip is pending and every control is disabled while in flight;
 *   a second tap does not post again;
 * - success collapses into the recorded answer at once, and it survives the
 *   refetch that drops the question; it clears when the agent moves on;
 * - an already-answered reply renders as recorded, never as an error;
 * - a real failure is an inline error with Retry, and the chips come back.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TaskActionZone } = await import('./TaskActionZone');
type Props = import('./TaskActionZone').TaskActionZoneProps;

const OPTIONS = ['Park and wait (recommended)', 'Ship it now'];
const waitingWorker = { id: 'w1', waitingFor: { prompt: 'Park or ship?', options: OPTIONS } };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let posts: string[];
let resolveNext: ((r: Response) => void) | null;
let changed: number;
const realFetch = globalThis.fetch;

beforeEach(() => {
  posts = [];
  resolveNext = null;
  changed = 0;
  globalThis.fetch = ((url: string) => {
    posts.push(String(url));
    // Only the respond call is held; the note reply is not made here (no noteId).
    return new Promise<Response>(resolve => { resolveNext = resolve; });
  }) as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

function render(over: Partial<Props> = {}) {
  const props: Props = {
    taskId: 't1',
    workspaceId: 'ws1',
    phase: 'waiting_input',
    isBlocked: false,
    blockedByCount: 0,
    backend: 'claude',
    lastError: null,
    worker: waitingWorker,
    onChanged: () => { changed += 1; },
    ...over,
  };
  act(() => { root.render(<TaskActionZone {...props} />); });
}

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const chips = () => [...container.querySelectorAll('[data-testid="respond-option"]')] as HTMLButtonElement[];

async function respond(status: number, body: unknown) {
  await act(async () => {
    resolveNext?.(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    await new Promise(r => setTimeout(r, 0));
  });
}

describe('TaskActionZone answering a question', () => {
  it('shows the tapped chip pending, disables everything, and posts once', () => {
    render();
    act(() => { chips()[0].click(); });

    expect(chips()[0].dataset.pending).toBe('true');
    expect(chips()[0].textContent).toContain('Sending…');
    expect(chips().every(c => c.disabled)).toBe(true);
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).disabled).toBe(true);

    act(() => { chips()[0].click(); chips()[1].click(); });
    expect(posts).toEqual(['/api/workers/w1/respond']);
  });

  it('collapses into the recorded answer at once, keeps it through the refetch, and clears when the agent moves on', async () => {
    render();
    act(() => { chips()[0].click(); });
    await respond(200, { path: 'resume', taskId: 't1', message: 'Resumed.' });

    const recorded = q('[data-testid="answer-recorded"]');
    expect(recorded?.textContent).toContain('You answered: Park and wait (recommended)');
    expect(recorded?.textContent).toContain('Answer sent, waiting for the agent');
    expect(chips()).toHaveLength(0);
    expect(changed).toBe(1);

    // The refetch: resume keeps the worker waiting_input, the question is gone.
    render({ worker: { id: 'w1', waitingFor: null } });
    expect(q('[data-testid="answer-recorded"]')?.textContent).toContain('You answered: Park and wait (recommended)');

    // The agent picked it up.
    render({ phase: 'running', worker: { id: 'w1', waitingFor: null } });
    expect(q('[data-testid="answer-recorded"]')).toBeNull();
  });

  it('renders a 409 already-answered as recorded, not as an error', async () => {
    render();
    act(() => { chips()[0].click(); });
    await respond(409, { error: 'Question was already answered', reasonCode: 'already_answered', recordedAnswer: 'Park and wait (recommended)' });

    const recorded = q('[data-testid="answer-recorded"]');
    expect(recorded?.dataset.outcome).toBe('already_answered');
    expect(recorded?.textContent).toContain('You answered: Park and wait (recommended)');
    expect(q('[data-testid="respond-error"]')).toBeNull();
    expect(container.textContent).not.toMatch(/error|failed/i);
  });

  it('says so when the recorded answer is not the one just tapped', async () => {
    render();
    act(() => { chips()[1].click(); });
    await respond(409, { error: 'Question was already answered', reasonCode: 'already_answered', recordedAnswer: 'Park and wait (recommended)' });

    const recorded = q('[data-testid="answer-recorded"]');
    expect(recorded?.dataset.differs).toBe('true');
    expect(recorded?.textContent).toContain('Already answered: Park and wait (recommended)');
    expect(recorded?.textContent).toContain('Ship it now');
  });

  it('shows the server-derived answered state when the question is gone but the agent has not resumed', () => {
    render({ worker: { id: 'w1', waitingFor: null } });
    expect(q('[data-testid="answer-recorded"]')?.textContent).toContain('Answer sent, waiting for the agent');
  });

  it('shows a real failure inline with Retry and re-enables the chips', async () => {
    render();
    act(() => { chips()[0].click(); });
    await respond(500, { error: 'Failed to record response' });

    expect(q('[data-testid="respond-error"]')?.textContent).toContain('Failed to record response');
    expect(chips().every(c => !c.disabled)).toBe(true);

    const retry = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry')!;
    act(() => { retry.click(); });
    expect(posts).toEqual(['/api/workers/w1/respond', '/api/workers/w1/respond']);
    expect(chips()[0].dataset.pending).toBe('true');
  });
});
