/**
 * The `notify` effect's AC-4 channel (S4a review): a merge GitHub reports for a delivery already
 * resolved without one asks a person to look. Fake ports: the handler's own copy and routing.
 */
import { describe, expect, test } from 'bun:test';
import { reviewHandlers } from './review';
import type { KernelPorts } from '../ports';

function harness(state: string) {
  const notices: Array<{ title: string; body: string; kind: string; prNumber: number | null }> = [];
  const ports = {
    store: { loadView: async () => ({ delivery: { id: 'd1', workspaceId: 'w1', repoFullName: 'acme/app', prNumber: 7, state }, rounds: [], attempts: [], findings: [] }) },
    notify: { team: async (n: { title: string; body: string; kind: string; prNumber: number | null }) => { notices.push(n); } },
  } as unknown as KernelPorts;
  return { notify: reviewHandlers(ports).notify!, notices };
}
const effect = (payload: Record<string, unknown>) => ({ id: 'e1', deliveryId: 'd1', transitionId: 't1', kind: 'notify', dedupeKey: 'k', payload, attemptCount: 1, delivery: null, transition: null, authority: 'kernel' }) as never;

describe('notify: merged_after_resolution', () => {
  test('an abandoned delivery GitHub merged pages the team, naming the PR and that the merge was not applied', async () => {
    const h = harness('ABANDONED');
    expect(await h.notify(effect({ event: 'merged_after_resolution', state: 'ABANDONED' }))).toEqual({ outcome: 'ok' });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ kind: 'needsAttention', title: 'PR #7 merged after it was abandoned', prNumber: 7 });
    expect(h.notices[0].body).toContain('the merge was not applied');
  });

  test('a superseded one says superseded', async () => {
    const h = harness('SUPERSEDED');
    await h.notify(effect({ event: 'merged_after_resolution', state: 'SUPERSEDED' }));
    expect(h.notices[0].title).toBe('PR #7 merged after it was superseded');
  });
});
