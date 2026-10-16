import { describe, it, expect } from 'bun:test';
import { pickTaskView } from './task-view';

const at = (iso: string) => new Date(iso);
const w = (id: string, status: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id, status, createdAt: at(createdAt), waitingFor: null as unknown, prUrl: null as string | null, prNumber: null as number | null, ...extra,
});
const ask = { type: 'question', prompt: 'Tabs or spaces?', options: ['Tabs', 'Spaces'] };
const note = (id: string, workerId: string | null) => ({ id, workerId, type: 'question', status: 'open', title: 'Tabs or spaces?', body: null, defaultChoice: null, createdAt: at('2026-10-13T10:00:00Z') });

describe('pickTaskView: the one worker pick the task page and the sheet share', () => {
  it('orders by createdAt then id, never by input position', () => {
    const v = pickTaskView({
      task: { status: 'in_progress' },
      workers: [w('a', 'completed', '2026-10-13T10:00:00Z'), w('b', 'completed', '2026-10-13T10:00:00Z')],
      openQuestions: [],
    });
    expect(v.ordered.map(x => x.id)).toEqual(['b', 'a']);
    expect(v.latestWorker?.id).toBe('b');
  });

  it('shows the worker parked on a question even when a newer worker has ended', () => {
    const v = pickTaskView({
      task: { status: 'in_progress' },
      workers: [
        w('new', 'failed', '2026-10-13T11:00:00Z'),
        w('old', 'waiting_input', '2026-10-13T10:00:00Z', { waitingFor: ask }),
      ],
      openQuestions: [note('n1', 'old')],
    });
    expect(v.shownWorker?.id).toBe('old');
    expect(v.activeWorker?.waitingFor).toEqual(ask);
    expect(v.questionNote?.id).toBe('n1');
    expect(v.openQuestionCount).toBe(1);
  });

  it('falls back to the newest worker when none is live', () => {
    const v = pickTaskView({
      task: { status: 'failed' },
      workers: [w('x', 'failed', '2026-10-13T10:00:00Z'), w('y', 'failed', '2026-10-13T11:00:00Z')],
      openQuestions: [],
    });
    expect(v.activeWorker).toBeUndefined();
    expect(v.shownWorker?.id).toBe('y');
  });

  it('never revives a question on an ended task', () => {
    const v = pickTaskView({
      task: { status: 'completed' },
      workers: [w('old', 'waiting_input', '2026-10-13T10:00:00Z', { waitingFor: ask })],
      openQuestions: [note('n1', 'old')],
    });
    expect(v.activeWorker).toBeUndefined();
    expect(v.shownWorker?.waitingFor ?? null).toBeNull();
    expect(v.questionNote).toBeNull();
    expect(v.openQuestionCount).toBe(0);
  });

  it('drops the question when recovery owns the next step', () => {
    const v = pickTaskView({
      task: { status: 'in_progress' },
      workers: [w('old', 'waiting_input', '2026-10-13T10:00:00Z', { waitingFor: ask })],
      openQuestions: [note('n1', 'old')],
      recovery: { supersedesQuestion: true },
    });
    expect(v.activeWorker?.id).toBe('old');
    expect(v.activeWorker?.waitingFor).toBeNull();
    expect(v.questionNote).toBeNull();
  });

  it('picks the newest worker with a PR', () => {
    const v = pickTaskView({
      task: { status: 'completed' },
      workers: [
        w('pr', 'completed', '2026-10-13T10:00:00Z', { prUrl: 'https://github.com/o/r/pull/1', prNumber: 1 }),
        w('later', 'completed', '2026-10-13T11:00:00Z'),
      ],
      openQuestions: [],
    });
    expect(v.prWorker?.id).toBe('pr');
  });
});
