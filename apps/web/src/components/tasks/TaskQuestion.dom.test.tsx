/**
 * TaskQuestion, mounted (happy-dom): the one question card the task page, the
 * mission task sheet, the Board and the timeline all answer with.
 *
 * - a question asked as a question note leads with the note's title on every
 *   surface, and answering it marks that note answered (the sheet used to
 *   show the raw prompt and leave the note open);
 * - option objects from a live question render (the timeline's old input
 *   crashed on them once), and plain strings from older rows still do;
 * - `full` is the page's hero, `compact` the card density;
 * - a stale card says where the work went instead of "try again";
 * - a host-owned submission still gets the note id.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TaskQuestion } = await import('./TaskQuestion');
type Props = import('./TaskQuestion').TaskQuestionProps;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: Array<{ url: string; body: unknown }>;
let replies: Array<{ status: number; body: unknown }>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  replies = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = replies.shift() ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
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

const ASK = { prompt: 'Round per line, or only the total?', options: ['Per line', 'Total only'] };
const NOTE = { id: 'n1', workerId: 'w1', type: 'question', status: 'open', title: 'How should totals round?', body: null, defaultChoice: 'Per line' };

function render(over: Partial<Props> = {}) {
  const props: Props = { taskId: 't1', workerId: 'w1', waitingFor: ASK, ...over };
  act(() => { root.render(<TaskQuestion {...props} />); });
}

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const chips = () => [...container.querySelectorAll('[data-testid="question-option"]')] as HTMLButtonElement[];
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('TaskQuestion', () => {
  it('leads with the prompt when no question note records the ask', () => {
    render();
    expect(q('[data-testid="worker-needs-input-prompt"]')?.textContent).toBe(ASK.prompt);
    expect(chips().map(c => c.textContent)).toEqual(['AlternativePer line', 'AlternativeTotal only']);
  });

  it('leads with the question note and recommends its default choice', () => {
    render({ questionNote: NOTE });
    expect(q('[data-testid="worker-needs-input-prompt"]')?.textContent).toBe('How should totals round?');
    expect(chips()[0].dataset.recommended).toBe('true');
  });

  it('answers the worker, then marks the question note answered', async () => {
    render({ questionNote: NOTE });
    act(() => { chips()[1].click(); });
    await settle();
    expect(calls.map(c => c.url)).toEqual(['/api/workers/w1/respond', '/api/tasks/t1/notes/n1/reply']);
    expect(calls[0].body).toEqual({ message: 'Total only' });
    expect(calls[1].body).toEqual({ title: 'Total only' });
    expect(q('[data-testid="answer-recorded"]')?.textContent).toContain('You answered: Total only');
  });

  it('answers in your own words', async () => {
    render();
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Round the total, then show the lines');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
    await settle();
    expect(calls[0]).toEqual({ url: '/api/workers/w1/respond', body: { message: 'Round the total, then show the lines' } });
  });

  it('renders option objects from a live question and plain strings from older rows', () => {
    render({
      waitingFor: {
        prompt: ASK.prompt,
        options: [
          { label: 'Round each line', consequence: 'The total matches the card charge.', recommended: true },
          { label: 'Round the total', description: 'Matches the ledger.' },
        ],
      },
    });
    expect(container.textContent).toContain('Round each line');
    expect(container.textContent).toContain('The total matches the card charge.');
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('is the page hero at full size and a card when compact', () => {
    render({ variant: 'full', testId: 'tq' });
    expect(q('[data-testid="tq"]')?.dataset.density).toBe('hero');
    render({ variant: 'compact', testId: 'tq' });
    expect(q('[data-testid="tq"]')?.dataset.density).toBe('feed');
  });

  it('says where the work went when the card is stale, not "try again"', async () => {
    replies.push({ status: 400, body: { error: 'This agent has already stopped.', reasonCode: 'worker_ended', nextAction: { kind: 'follow_up' } } });
    render();
    act(() => { chips()[0].click(); });
    await settle();
    const err = q('[data-testid="worker-answer-error"]');
    expect(err?.textContent).toContain('This agent has already stopped.');
    expect(err?.querySelector('a')?.getAttribute('href')).toBe('/app/tasks/t1');
    expect(err?.textContent).not.toMatch(/try again/i);
  });

  it('keeps a real failure retryable in place', async () => {
    replies.push({ status: 500, body: { error: 'Failed to record response' } });
    render();
    act(() => { chips()[0].click(); });
    await settle();
    expect(q('[data-testid="worker-answer-error"]')?.textContent).toContain('Failed to record response');
    expect(chips().every(c => !c.disabled)).toBe(true);
  });

  it('links the follow-up task when the answer started one', async () => {
    replies.push({ status: 200, body: { path: 'cold_continuation', taskId: 't9', message: 'Started a follow-up task with your answer.' } });
    render();
    act(() => { chips()[0].click(); });
    await settle();
    const sent = q('[data-testid="worker-answer-sent"]');
    expect(sent?.textContent).toContain('Started a follow-up task with your answer.');
    expect(sent?.querySelector('a')?.getAttribute('href')).toBe('/app/tasks/t9');
  });

  it('passes the note id to a submission the host owns', async () => {
    const sent: Array<{ message: string; noteId: string | null | undefined }> = [];
    render({
      questionNote: NOTE,
      answer: { submit: async (message, opts) => { sent.push({ message, noteId: opts?.noteId }); }, sending: null, outcome: null, error: null },
    });
    act(() => { chips()[0].click(); });
    await settle();
    expect(sent).toEqual([{ message: 'Per line', noteId: 'n1' }]);
    expect(calls).toHaveLength(0);
  });
});
