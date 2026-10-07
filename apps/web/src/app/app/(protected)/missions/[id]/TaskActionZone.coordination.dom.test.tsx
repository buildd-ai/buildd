/**
 * A queued task a coordination gate holds, mounted (happy-dom). The live bug
 * (task 1fd75933): an idle runner, a task overlapping open PR #3818 on
 * packages/core/db/schema.ts — the sheet said "Queued at front · No runner
 * has responded" and Force start could not get past the overlap.
 *
 * - the queued task names the blocker ("Waiting on PR #3818 … because both
 *   edit …"), never runner-liveness copy;
 * - Run now's refusal is the same waiting line plus a Force start
 *   confirmation naming the gate it skips and the rails that remain;
 * - Force start posts the refusal's reasons digest (`forceCoordination`) —
 *   not `forceOverride`, not a claim — and then says what it skipped;
 * - a wait no force lifts offers no Force start.
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
const { makeWaitingReason, coordinationHoldBody } = await import('@buildd/core/waiting-reason');
type Props = import('./TaskActionZone').TaskActionZoneProps;

const prHold = makeWaitingReason('pr_overlap_ended', {
  because: 'both edit packages/core/db/schema.ts',
  blocker: { type: 'pr', id: '3818', label: 'PR #3818', href: 'https://github.com/o/r/pull/3818', live: false },
  overlap: { areas: [{ area: 'core/db', count: 1 }], pathCount: 1, paths: ['packages/core/db/schema.ts'], basis: 'declared' },
  provenance: { source: 'probe', derivedFrom: 'claim layer 1' },
});
const mutexHold = makeWaitingReason('scope_undeclared_mutex', {
  because: 'neither task declares the files it edits, so the mission runs one at a time',
  blocker: { type: 'task', id: 'peer', label: '“peer task”', href: '/app/tasks/peer', live: true },
  provenance: { source: 'probe', derivedFrom: 'advisory_manifest' },
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: Array<{ url: string; method: string; body: any }>;
let hold: ReturnType<typeof makeWaitingReason>[];
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = [];
  hold = [prHold];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), method, body });
    if (String(url).endsWith('/waiting')) return json(200, { ...(hold.length ? coordinationHoldBody(hold) : {}), waitingReasons: hold, probed: true });
    if (String(url).endsWith('/start')) {
      if (hold.length === 0) return json(200, { started: true, taskId: 't1' });
      const refusal = coordinationHoldBody(hold);
      if (body?.forceCoordination?.reasonsDigest === refusal.reasonsDigest && refusal.canForce) {
        return json(200, { started: true, taskId: 't1', forced: { forceId: 'f1', gates: refusal.force!.gates, railsRemaining: refusal.force!.railsRemaining, expiresAt: new Date(Date.now() + 9e5).toISOString() } });
      }
      return json(422, refusal);
    }
    if (String(url).endsWith('/api/tasks/t1')) return json(200, { status: 'pending' });
    return json(200, {});
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

async function render(over: Partial<Props> = {}) {
  const props: Props = {
    taskId: 't1', workspaceId: 'ws1', phase: 'pending', isBlocked: false, blockedByCount: 0,
    backend: 'claude', lastError: null, worker: null, ...over,
  };
  await act(async () => { root.render(<TaskActionZone {...props} />); await new Promise(r => setTimeout(r, 0)); });
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
async function click(sel: string) {
  await act(async () => { q(sel)!.click(); await new Promise(r => setTimeout(r, 0)); });
}

describe('TaskActionZone: coordination holds', () => {
  it('a queued task names its blocker, not the runner fleet', async () => {
    await render();
    const line = q('[data-testid="task-waiting-line"]');
    expect(line?.dataset.kind).toBe('pr_overlap_ended');
    expect(line?.dataset.chip).toBe('held');
    expect(line?.textContent).toContain('Waiting on PR #3818');
    expect(line?.textContent).toContain('because both edit packages/core/db/schema.ts');
    expect(container.textContent).not.toContain('Waiting for a runner');
    expect(container.textContent).not.toMatch(/no runner has responded/i);
  });

  it('Run now refuses with the blocker and a Force start confirmation naming the gate and the rails', async () => {
    await render();
    await click('[data-action="run_now"]');
    const refusal = q('[data-testid="task-start-refusal"]');
    expect(refusal?.dataset.gate).toBe('coordination_hold');
    expect(refusal?.textContent).toContain('Waiting on PR #3818');
    const confirm = q('[data-testid="task-force-confirm"]')!;
    expect(confirm.textContent).toContain('Force start skips: Open-PR file overlap');
    expect(confirm.textContent).toContain('Still enforced:');
    expect(confirm.textContent).toContain('Files another agent is editing stay locked');
    expect(container.textContent).not.toMatch(/runners? online|no runner has responded/i);
  });

  it('Force start posts the confirmed digest — not forceOverride — and reports what it skipped', async () => {
    await render();
    await click('[data-action="run_now"]');
    await click('[data-action="force_start"]');
    const post = calls.filter(c => c.url.endsWith('/start')).at(-1)!;
    expect(post.body.forceCoordination.reasonsDigest).toBe(coordinationHoldBody([prHold]).reasonsDigest);
    expect(post.body.forceOverride).toBeUndefined();
    expect(calls.some(c => c.url.includes('/api/workers/claim'))).toBe(false);
    const status = q('[data-testid="task-start-status"]');
    expect(status?.textContent).toContain('Force start requested');
    expect(status?.textContent).toContain('Skipping: Open-PR file overlap');
  });

  it('the waiting line itself offers Force start… that opens the same confirmation', async () => {
    await render();
    await click('[data-action="force_start_offer"]');
    expect(q('[data-testid="task-force-confirm"]')).not.toBeNull();
  });

  it('a wait no force can lift offers no Force start', async () => {
    hold = [mutexHold];
    await render();
    expect(q('[data-action="force_start_offer"]')).toBeNull();
    await click('[data-action="run_now"]');
    expect(q('[data-action="force_start"]')).toBeNull();
    expect(container.textContent).toContain("Can't be forced: One scope-undeclared task per mission");
  });

  it('nothing holding it: the plain queued copy, no waiting line', async () => {
    hold = [];
    await render();
    expect(q('[data-testid="task-waiting-line"]')).toBeNull();
    expect(container.textContent).toContain('Waiting for a runner to claim it.');
  });
});
