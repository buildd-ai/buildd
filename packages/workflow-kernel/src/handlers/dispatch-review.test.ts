import { describe, expect, test } from 'bun:test';
import { reviewHandlers } from './review';
import type { KernelPorts } from '../ports';

function harness(live: Record<string, unknown> | null = { headSha: 'head-a', state: 'open', baseRef: 'dev' }) {
  const facts: string[] = [];
  let filed = 0;
  let reads = 0;
  const ports = {
    store: {
      loadView: async () => ({ delivery: { id: 'd1', workspaceId: 'w1', repoFullName: 'acme/app', prNumber: 7, state: 'AWAITING_REVIEW', currentHeadSha: 'head-a', baseRef: 'dev' }, rounds: [{ id: 'r1', round: 1, kind: 'full', status: 'queued', headSha: 'head-a' }], attempts: [], findings: [] }),
      linkRoundReviewer: async () => {},
    },
    github: { readPr: async () => { reads++; return live; } },
    ingest: { ingest: async (fact: { kind: string }, reader: { readPr: () => Promise<unknown> }) => { expect(await reader.readPr()).toBe(live); facts.push(fact.kind); return { result: 'applied' }; } },
    reviews: { attestComposition: async () => null },
    work: { file: async () => { filed++; return { taskId: 'review-task', created: true }; }, cancelPending: async () => {}, wake: async () => {} },
  } as unknown as KernelPorts;
  return { ports, run: () => reviewHandlers(ports).dispatch_review!({ id: 'e1', deliveryId: 'd1', transitionId: 't1', kind: 'dispatch_review', dedupeKey: 'k', payload: { roundId: 'r1', revalidate: true }, attemptCount: 1, delivery: null, transition: null }), facts, filed: () => filed, reads: () => reads };
}

describe('dispatch_review deferred GitHub revalidation', () => {
  test('waits for GitHub in the effect before filing the reviewer', async () => {
    const h = harness();
    let release!: () => void;
    h.ports.github!.readPr = async () => { await new Promise<void>((resolve) => { release = resolve; }); return { headSha: 'head-a', state: 'open', baseRef: 'dev' } as never; };
    const running = h.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.filed()).toBe(0);
    expect(release).toBeFunction();
    release();
    expect(await running).toEqual({ outcome: 'ok' });
    expect(h.filed()).toBe(1);
  });
  test('passes the callback saved on its round to the reviewer task', async () => {
    const h = harness();
    const original = h.ports.store.loadView;
    const reviewCallback = { url: 'https://example.test/hook', on: 'merge' };
    h.ports.store.loadView = async (ref) => {
      const v = await original(ref);
      v.rounds[0] = { ...v.rounds[0], scope: { reviewCallback } };
      return v;
    };
    let detail: Record<string, unknown> | undefined;
    h.ports.work!.file = async (req) => { detail = req.detail; return { taskId: 'review-task', created: true }; };
    await h.run();
    expect(detail?.reviewCallback).toEqual(reviewCallback);
  });
  test('a round superseded while GitHub is read is not dispatched', async () => {
    const h = harness();
    const original = h.ports.store.loadView;
    let loads = 0;
    h.ports.store.loadView = async (ref) => {
      const v = await original(ref);
      if (++loads > 1) v.rounds[0] = { ...v.rounds[0], status: 'superseded' };
      return v;
    };
    expect(await h.run()).toEqual({ outcome: 'skipped:round_closed' });
    expect(h.filed()).toBe(0);
  });
  for (const [live, kind, outcome] of [
    [{ headSha: 'head-b', state: 'open' }, 'head_observed', 'head_moved'],
    [{ headSha: 'head-a', state: 'closed' }, 'pr_closed', 'pr_closed'],
    [{ headSha: 'head-a', state: 'closed', merged: true }, 'pr_closed', 'pr_merged'],
    [{ headSha: 'head-a', state: 'open', baseRef: 'main' }, 'base_changed', 'base_moved'],
  ] as const) {
    test(`${outcome} records the live fact and skips the obsolete reviewer`, async () => {
      const h = harness(live);
      expect(await h.run()).toEqual({ outcome: `skipped:${outcome}:applied` });
      expect(h.facts).toEqual([kind]);
      expect(h.reads()).toBe(1);
      expect(h.filed()).toBe(0);
    });
  }
  test('an unread PR throws so the outbox retries without filing', async () => {
    const h = harness(null);
    await expect(h.run()).rejects.toThrow('live PR read failed');
    expect(h.filed()).toBe(0);
  });
});
