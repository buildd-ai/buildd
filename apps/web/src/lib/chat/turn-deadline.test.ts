import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TURN_BUDGET_MS, TURN_STOPPED_NOTE, TURN_WATCHDOG_GRACE_MS, TURN_WRAP_UP_MS, USAGE_SETTLE_MS,
  settleWithin, withDeadlineWatchdog, withStoppedNote, wrapUpStep,
} from './turn-deadline';

async function drain<T>(s: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const r = s.getReader();
  for (;;) { const { done, value } = await r.read(); if (done) return out; out.push(value); }
}

describe('the route has room for the whole turn', () => {
  it('maxDuration covers the budget, the watchdog grace and persistence', () => {
    const src = readFileSync(join(import.meta.dir, '../../app/api/chat/[id]/route.ts'), 'utf8');
    const m = src.match(/export const maxDuration = (\d+);/);
    expect(m).not.toBeNull();
    const maxMs = Number(m![1]) * 1000;
    // 30s for persistence, the directive card and after() work.
    expect(maxMs).toBeGreaterThanOrEqual(TURN_BUDGET_MS + TURN_WATCHDOG_GRACE_MS + USAGE_SETTLE_MS + 30_000);
    expect(TURN_WRAP_UP_MS).toBeLessThan(TURN_BUDGET_MS);
  });
});

describe('wrapUpStep', () => {
  it('leaves the first step and early steps alone', () => {
    expect(wrapUpStep({ stepNumber: 0, elapsedMs: 999_999, wrapUpMs: 1, instructions: 'x' })).toBeUndefined();
    expect(wrapUpStep({ stepNumber: 2, elapsedMs: 10, wrapUpMs: 100, instructions: 'x' })).toBeUndefined();
  });
  it('past the mark: no tools, and the instruction to answer now', () => {
    const s = wrapUpStep({ stepNumber: 3, elapsedMs: 100, wrapUpMs: 100, instructions: 'base' })!;
    expect(s.toolChoice).toBe('none');
    expect(s.instructions.startsWith('base\n\n')).toBe(true);
    expect(s.instructions).toContain('Do not call any more tools');
  });
});

describe('withDeadlineWatchdog', () => {
  it('passes a stream that ends in time through untouched', async () => {
    let fired = false;
    const src = new ReadableStream({ start(c) { c.enqueue(1); c.enqueue(2); c.close(); } });
    expect(await drain(withDeadlineWatchdog(src, Date.now() + 1_000, () => { fired = true; }))).toEqual([1, 2]);
    expect(fired).toBe(false);
  });
  it('ends a stream that never closes with one abort part, and says so once', async () => {
    let fired = 0;
    let cancelled = false;
    const src = new ReadableStream({ start(c) { c.enqueue({ type: 'text-delta' }); }, cancel() { cancelled = true; } });
    const out = await drain(withDeadlineWatchdog(src, Date.now() + 50, () => { fired++; }));
    expect(out).toEqual([{ type: 'text-delta' }, { type: 'abort', reason: 'turn deadline watchdog' }]);
    expect(fired).toBe(1);
    expect(cancelled).toBe(true);
  });
});

describe('withStoppedNote', () => {
  it('puts the note in as text right before the abort chunk', async () => {
    const src = new ReadableStream<any>({ start(c) { c.enqueue({ type: 'start' }); c.enqueue({ type: 'abort' }); c.close(); } });
    const out = await drain(withStoppedNote(src));
    expect(out.map(c => c.type)).toEqual(['start', 'text-start', 'text-delta', 'text-end', 'abort']);
    expect(out[2].delta).toBe(TURN_STOPPED_NOTE);
  });
  it('a turn that finishes normally gets no note', async () => {
    const src = new ReadableStream<any>({ start(c) { c.enqueue({ type: 'start' }); c.enqueue({ type: 'finish' }); c.close(); } });
    expect((await drain(withStoppedNote(src))).map(c => c.type)).toEqual(['start', 'finish']);
  });
});

describe('settleWithin', () => {
  it('the value, or undefined on timeout or failure', async () => {
    expect(await settleWithin(Promise.resolve(3), 50)).toBe(3);
    expect(await settleWithin(new Promise(() => {}), 10)).toBeUndefined();
    expect(await settleWithin(Promise.reject(new Error('x')), 50)).toBeUndefined();
  });
});
