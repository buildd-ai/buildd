import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockReportOps = mock((_e: any) => Promise.resolve());
mock.module('@buildd/core/report-ops', () => ({ reportOps: mockReportOps }));
// The composition root pulls in every module; these tests pass their own list.
mock.module('@/modules', () => ({ SUBSCRIBERS: [] }));

const { emit } = await import('./core-emit');
const { subscriber } = await import('./core-events');
import type { AnySubscriber, CoreEvent } from './core-events';

const terminal: CoreEvent = { type: 'task.terminal', taskId: 't-1', workerId: 'w-1', workspaceId: 'ws-1', sensitive: false };

beforeEach(() => mockReportOps.mockClear());

describe('emit', () => {
  it('runs only the subscribers for the event type, in list order', async () => {
    const seen: string[] = [];
    const subs: AnySubscriber[] = [
      subscriber('a', 'task.terminal', 'first', () => { seen.push('first'); }),
      subscriber('b', 'pr.merged', 'other-type', () => { seen.push('other-type'); }),
      subscriber('c', 'task.terminal', 'second', async () => { await Promise.resolve(); seen.push('second'); }),
      subscriber('d', 'task.terminal', 'third', () => { seen.push('third'); }),
    ];
    await emit(terminal, { subscribers: subs });
    expect(seen).toEqual(['first', 'second', 'third']);
  });

  it('awaits each subscriber before the next starts', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const subs: AnySubscriber[] = [
      subscriber('a', 'task.terminal', 'slow', async () => { await gate; seen.push('slow'); }),
      subscriber('a', 'task.terminal', 'next', () => { seen.push('next'); }),
    ];
    const done = emit(terminal, { subscribers: subs });
    await Promise.resolve();
    expect(seen).toEqual([]);
    release();
    await done;
    expect(seen).toEqual(['slow', 'next']);
  });

  it('starts the first subscriber synchronously, so after() work lands inside the caller', () => {
    let ran = false;
    void emit(terminal, { subscribers: [subscriber('a', 'task.terminal', 'sync', () => { ran = true; })] });
    expect(ran).toBe(true);
  });

  it('isolates a throwing subscriber: it pages under its label, the next still runs, emit resolves', async () => {
    const seen: string[] = [];
    const subs: AnySubscriber[] = [
      subscriber('a', 'task.terminal', 'boom', () => { throw new Error('store down'); }),
      subscriber('a', 'task.terminal', 'rejects', async () => { throw new Error('still down'); }),
      subscriber('a', 'task.terminal', 'after', () => { seen.push('after'); }),
    ];
    await expect(emit(terminal, { subscribers: subs })).resolves.toBeUndefined();
    expect(seen).toEqual(['after']);
    expect(mockReportOps.mock.calls.map(c => c[0].source)).toEqual(['core-event:boom', 'core-event:rejects']);
    expect(mockReportOps.mock.calls[0]![0]).toMatchObject({ severity: 'error', message: 'boom failed', detail: 'store down' });
  });

  it("uses the caller's isolate when given one, with each subscriber's label", async () => {
    const labels: string[] = [];
    const isolate = async (label: string, fn: () => Promise<void>) => { labels.push(label); try { await fn(); } catch { /* caller pages */ } };
    await emit(terminal, {
      isolate,
      subscribers: [
        subscriber('a', 'task.terminal', 'one', () => { throw new Error('x'); }),
        subscriber('a', 'task.terminal', 'two', () => {}),
      ],
    });
    expect(labels).toEqual(['one', 'two']);
    expect(mockReportOps).not.toHaveBeenCalled();
  });

  it('a throwing isolate still does not stop the fan-out or reject', async () => {
    const seen: string[] = [];
    const isolate = async (label: string, fn: () => Promise<void>) => { await fn(); if (label === 'one') throw new Error('isolate bug'); };
    await emit(terminal, {
      isolate,
      subscribers: [
        subscriber('a', 'task.terminal', 'one', () => { seen.push('one'); }),
        subscriber('a', 'task.terminal', 'two', () => { seen.push('two'); }),
      ],
    });
    expect(seen).toEqual(['one', 'two']);
  });

  it('with no subscribers for the type, is a no-op', async () => {
    await expect(emit(terminal, { subscribers: [] })).resolves.toBeUndefined();
  });
});
