// The re-embed driver (docs/specs/local-runner-provider.md §5.3 D-3, D-6): a
// namespace whose model or size changed is walked in bounded batches until it
// is done, without starving the tick and without ever throwing.
import { describe, it, expect } from 'bun:test';
import { runReembedTick, REEMBED_TICK_BUDGET_MS } from './knowledge-reembed';

type Step = { status: 'done' | 'running' | 'denied' | 'skipped'; processed: number; remaining: number };
const ns = (namespace: string) => ({ namespace, model: 'nomic-embed-text', dimensions: 768, vectorColumn: 'embedding_768' as const, provider: 'local_runner', reembedStatus: 'pending' as const, reembedTotal: 10, reembedDone: 0 });

function deps(script: Record<string, Step[] | Error>, clock = { t: 0, step: 1_000 }) {
  const walked: string[] = [];
  return {
    walked,
    deps: {
      list: async () => Object.keys(script).map(ns),
      reembed: async (namespace: string) => {
        walked.push(namespace);
        clock.t += clock.step;
        const s = script[namespace];
        if (s instanceof Error) throw s;
        return s.shift() ?? { status: 'done' as const, processed: 0, remaining: 0 };
      },
      now: () => clock.t,
    },
  };
}

describe('runReembedTick', () => {
  it('walks a pending namespace batch by batch until it is done', async () => {
    const d = deps({ 'ws-1:code': [{ status: 'running', processed: 16, remaining: 20 }, { status: 'running', processed: 16, remaining: 4 }, { status: 'done', processed: 4, remaining: 0 }] });
    const out = await runReembedTick({}, d.deps);
    expect(d.walked).toEqual(['ws-1:code', 'ws-1:code', 'ws-1:code']);
    expect(out).toEqual({ namespaces: 1, processed: 36, done: 1, denied: 0, failed: 0 });
  });

  it('a denied batch (runner offline, spend guard) leaves the namespace for the next tick and moves on', async () => {
    const d = deps({ 'ws-1:code': [{ status: 'denied', processed: 0, remaining: 30 }], 'ws-1:memory': [{ status: 'done', processed: 5, remaining: 0 }] });
    const out = await runReembedTick({}, d.deps);
    expect(d.walked).toEqual(['ws-1:code', 'ws-1:memory']);
    expect(out).toMatchObject({ namespaces: 2, done: 1, denied: 1, processed: 5 });
  });

  it('bounded per namespace and by the tick budget, so live work is never starved', async () => {
    const endless = (): Step[] => Array.from({ length: 50 }, () => ({ status: 'running' as const, processed: 16, remaining: 999 }));
    const perNs = deps({ 'ws-1:code': endless(), 'ws-1:memory': endless() });
    await runReembedTick({ batchesPerNamespace: 3 }, perNs.deps);
    expect(perNs.walked).toEqual(['ws-1:code', 'ws-1:code', 'ws-1:code', 'ws-1:memory', 'ws-1:memory', 'ws-1:memory']);

    const slow = deps({ 'ws-1:code': endless(), 'ws-1:memory': endless() }, { t: 0, step: REEMBED_TICK_BUDGET_MS });
    await runReembedTick({}, slow.deps);
    expect(slow.walked).toEqual(['ws-1:code']);
  });

  it('never throws: a namespace that fails is counted and the next one still runs; a failed listing is an empty tick', async () => {
    const d = deps({ 'ws-1:code': new Error('boom'), 'ws-1:memory': [{ status: 'done', processed: 2, remaining: 0 }] });
    expect(await runReembedTick({}, d.deps)).toMatchObject({ failed: 1, done: 1 });
    const out = await runReembedTick({}, { ...d.deps, list: async () => { throw new Error('db down'); } });
    expect(out).toEqual({ namespaces: 0, processed: 0, done: 0, denied: 0, failed: 0 });
  });
});
