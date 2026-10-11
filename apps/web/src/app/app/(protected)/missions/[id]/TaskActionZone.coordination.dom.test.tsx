/**
 * A queued task a coordination gate holds, mounted (happy-dom). The live bug
 * (task 1fd75933): an idle runner, a task overlapping open PR #1234 on
 * packages/core/db/schema.ts — the sheet said "Queued at front · No runner
 * has responded" and Force start could not get past the overlap.
 *
 * - the queued task names the blocker ("Waiting on PR #1234 … because both
 *   edit …"), never runner-liveness copy;
 * - Run now's refusal is the same waiting line plus a Force start
 *   confirmation naming the gate it skips and the rails that remain;
 * - Force start posts the ticked kinds and the refusal's reasons digest
 *   (`force`) — not `forceOverride`, not a claim — and then says what it skipped;
 * - a wait no force lifts offers no Force start;
 * - a task blocked only by creation-time migration-overlap edges (and a local
 *   mission) says "Waiting on migration slot · N tasks also editing …", never
 *   "waiting on N dependencies", and one Force start lifts all of it.
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
  blocker: { type: 'pr', id: '1234', label: 'PR #1234', href: 'https://github.com/o/r/pull/1234', live: false },
  overlap: { areas: [{ area: 'core/db', count: 1 }], pathCount: 1, paths: ['packages/core/db/schema.ts'], basis: 'declared' },
  provenance: { source: 'probe', derivedFrom: 'claim layer 1' },
});
const roleHold = makeWaitingReason('role_unavailable', {
  because: 'no online runner offers the builder role',
  provenance: { source: 'runner_fleet', derivedFrom: 'fleet skills' },
});
const migrationEdge = (id: string) => makeWaitingReason('dep_inferred', {
  because: 'both add a migration packages/core/db/schema.ts',
  blocker: { type: 'task', id, label: `“holder ${id}”`, href: `/app/tasks/${id}`, live: true },
  overlap: { areas: [{ area: 'core/db', count: 1 }], pathCount: 1, paths: ['packages/core/db/schema.ts'], basis: 'declared', overlapKind: 'migration' },
  provenance: { source: 'task_context', derivedFrom: 'tasks.pathDeclaration.inferredDependsOn' },
});
const localHold = makeWaitingReason('mission_local', {
  because: "its mission runs in a person's own session, so runners do not pick up its tasks",
  blocker: { type: 'mission', id: 'm1', label: 'a local-session mission', href: '/app/missions/m1' },
  provenance: { source: 'probe', derivedFrom: "missions.executor='local'" },
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
      if (body?.force?.reasonsDigest === refusal.reasonsDigest && refusal.canForce) {
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
    expect(line?.textContent).toContain('Waiting on PR #1234');
    expect(line?.textContent).toContain('because both edit packages/core/db/schema.ts');
    expect(container.textContent).not.toContain('Waiting for a runner');
    expect(container.textContent).not.toMatch(/no runner has responded/i);
  });

  it('Run now refuses with the blocker and a Force start confirmation naming the gate and the rails', async () => {
    await render({ taskTitle: 'Fix schema' });
    await click('[data-action="run_now"]');
    const refusal = q('[data-testid="task-start-refusal"]');
    expect(refusal?.dataset.gate).toBe('coordination_hold');
    expect(refusal?.textContent).toContain('Waiting on PR #1234');
    const confirm = q('[data-testid="task-force-confirm"]')!;
    expect(confirm.textContent).toContain('Force start “Fix schema”?');
    expect(confirm.textContent).toContain('Skips: Open-PR file overlap: PR #1234: both edit packages/core/db/schema.ts');
    expect(confirm.textContent).toContain('Risk: core/db overlap · declared files');
    expect(confirm.textContent).toContain('Still enforced:');
    expect(confirm.textContent).toContain('Files another agent is editing stay locked');
    expect(container.textContent).not.toMatch(/runners? online|no runner has responded/i);
  });

  it('Force start posts the confirmed digest — not forceOverride — and reports what it skipped', async () => {
    await render();
    await click('[data-action="run_now"]');
    await click('[data-action="force_start"]');
    const post = calls.filter(c => c.url.endsWith('/start')).at(-1)!;
    expect(post.body.force).toEqual({ kinds: ['pr_overlap_ended'], reasonsDigest: coordinationHoldBody([prHold]).reasonsDigest });
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

  it('a wait no force can lift (a capability gap) offers no Force start', async () => {
    hold = [prHold, roleHold];
    await render();
    expect(q('[data-action="force_start_offer"]')).toBeNull();
    await click('[data-action="run_now"]');
    expect(q('[data-action="force_start"]')).toBeNull();
    expect(container.textContent).toContain("Can't be forced: No runner for this role");
  });

  it('blocked only by inferred migration edges: the migration slot, not "N dependencies", and one Force start', async () => {
    hold = ['h1', 'h2', 'h3', 'h4', 'h5'].map(migrationEdge);
    await render({ isBlocked: true, blockedByCount: 5 });
    const panel = q('[data-testid="task-blocked-waiting"]')!;
    expect(panel.textContent).toContain('Waiting on migration slot · 5 tasks also editing core/db');
    expect(container.textContent).not.toMatch(/waiting on 5 dependencies/i);
    // Paths are drilldown only: the compact line names the area.
    expect(q('[data-testid="task-waiting-headline"]')!.textContent).not.toContain('schema.ts');

    await click('[data-action="force_start_offer"]');
    expect(container.querySelectorAll('[data-testid="task-force-skip"]')).toHaveLength(5);
    expect(q('[data-testid="task-force-red-line"]')!.textContent).toContain('Migration numbering stays serialized');
    await click('[data-action="force_start"]');
    const post = calls.filter(c => c.url.endsWith('/start')).at(-1)!;
    expect(post.body.force.kinds).toEqual(['dep_inferred']);
  });

  it('a local mission held by coordination too: one press lifts both', async () => {
    hold = [localHold, migrationEdge('h1')];
    await render({ missionExecutor: 'local' });
    await click('[data-action="force_start_offer"]');
    expect(container.querySelectorAll('[data-testid="task-force-skip"]')).toHaveLength(2);
    await click('[data-action="force_start"]');
    const posts = calls.filter(c => c.url.endsWith('/start'));
    expect(posts).toHaveLength(1);
    expect([...posts[0].body.force.kinds].sort()).toEqual(['dep_inferred', 'mission_local']);
  });

  it('a declared dependency stays: blocked panel says so and offers no Force start', async () => {
    hold = [migrationEdge('h1'), makeWaitingReason('dep_declared', {
      because: 'it was declared as a dependency',
      blocker: { type: 'task', id: 'd1', label: '“design first”', href: '/app/tasks/d1' },
      provenance: { source: 'task_context', derivedFrom: 'tasks.dependsOn' },
    })];
    await render({ isBlocked: true, blockedByCount: 2 });
    const text = q('[data-testid="task-blocked-waiting"]')!.textContent!;
    // The declared dependency is the headline; the overlap edge is named as ordering, not a dependency.
    expect(text).toContain('Waiting on “design first”');
    expect(text).toContain('Also: file-overlap ordering');
    expect(q('[data-action="force_start_offer"]')).toBeNull();
  });

  it('nothing holding it: the plain queued copy, no waiting line', async () => {
    hold = [];
    await render();
    expect(q('[data-testid="task-waiting-line"]')).toBeNull();
    expect(container.textContent).toContain('Waiting for a runner to claim it.');
  });
});
