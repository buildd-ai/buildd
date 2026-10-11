import { describe, it, expect } from 'bun:test';
import {
  WAITING_KIND_SPEC,
  areaOfPath,
  canForceStart,
  claimLoopKeysFor,
  coordinationHoldBody,
  forceDialog,
  isStartForceable,
  prefilterLiftsFor,
  waitingSummary,
  makeWaitingReason,
  orderWaitingReasons,
  overlapAreas,
  readForceStart,
  waitingChip,
  waitingReasonsDigest,
  type WaitingKind,
} from '../waiting-reason';

const r = (kind: WaitingKind, id = 'x') =>
  makeWaitingReason(kind, { because: 'b', blocker: { type: 'task', id, label: id }, provenance: { source: 'probe', derivedFrom: 't' } });

/** A creation-time overlap edge on a migration path (the shape of a schema task queued behind others). */
const migrationEdge = (id: string) => makeWaitingReason('dep_inferred', {
  because: 'both add a migration',
  blocker: { type: 'task', id, label: `“holder ${id}”` },
  overlap: { areas: [{ area: 'core/db', count: 1 }], pathCount: 1, paths: ['packages/core/db/schema.ts'], basis: 'declared', overlapKind: 'migration' },
  provenance: { source: 'task_context', derivedFrom: 'tasks.pathDeclaration.inferredDependsOn' },
});

describe('waiting-reason', () => {
  it('orders capability first, then hard intentional, hard incidental, soft', () => {
    const out = orderWaitingReasons([r('ordered_behind'), r('account_slots'), r('pr_overlap_live'), r('role_unavailable')]);
    expect(out.map(x => x.kind)).toEqual(['role_unavailable', 'pr_overlap_live', 'account_slots', 'ordered_behind']);
  });

  it('forceable only when every blocking reason is lifted through the start context', () => {
    expect(canForceStart([r('pr_overlap_live'), r('mission_concurrent')])).toBe(true);
    // Human force lifts the scope-undeclared mutex and planner order (§7.2).
    expect(canForceStart([r('pr_overlap_live'), r('scope_undeclared_mutex')])).toBe(true);
    // One non-forceable reason: the task still would not start.
    expect(canForceStart([r('pr_overlap_live'), r('dep_declared')])).toBe(false);
    expect(canForceStart([migrationEdge('a'), r('mission_local')])).toBe(true);
    expect(canForceStart([r('role_unavailable')])).toBe(false);
    expect(canForceStart([r('task_held')])).toBe(false);
    // Soft only: nothing to force.
    expect(canForceStart([r('ordered_behind')])).toBe(false);
    expect(canForceStart([])).toBe(false);
  });

  it('capability, budget, seat, hold and unknown kinds are never forceable', () => {
    for (const k of ['task_held', 'account_slots', 'oauth_parallelism', 'codex_single_flight', 'managed_entitlement',
      'budget_paused', 'provider_unavailable', 'role_unavailable', 'capability_mismatch', 'runner_cooldown',
      'lease_stale', 'dep_declared', 'unknown'] as WaitingKind[]) {
      expect(WAITING_KIND_SPEC[k].force).toBeNull();
      expect(isStartForceable(k)).toBe(false);
    }
  });

  it('maps kinds to exactly the claim-loop keys they lift', () => {
    expect(claimLoopKeysFor(['pr_overlap_live', 'lease_overlap', 'mission_paced']).sort()).toEqual(['mission_paced', 'path_overlap']);
    expect(claimLoopKeysFor(['scope_undeclared_mutex', 'ordered_behind', 'serialized_surface', 'soft_overlap']).sort())
      .toEqual(['advisory_manifest', 'ordered_behind', 'soft_overlap']);
    expect(claimLoopKeysFor(['mission_budget', 'task_held', 'dep_declared'])).toEqual([]);
    expect(prefilterLiftsFor(['dep_inferred', 'mission_local', 'dep_declared']).sort()).toEqual(['inferred_deps', 'local_mission']);
  });

  it('summary keeps declared dependencies apart from coordination-only ordering', () => {
    const edges = ['a', 'b', 'c', 'd', 'e'].map(migrationEdge);
    expect(waitingSummary(edges).headline).toBe('Waiting on migration slot · 5 tasks also editing core/db');
    expect(waitingSummary(edges).declared).toBe(0);
    const mixed = waitingSummary([...edges, r('dep_declared', 'z')]);
    expect(mixed.headline).toBe('Waiting on 1 declared dependency');
    expect(mixed.coordination).toBe(5);
  });

  it('force dialog: one checklist line per gate, the migration red line, rails with the file count', () => {
    const d = forceDialog([migrationEdge('a'), migrationEdge('b'), r('mission_local', 'm')]);
    expect(d.checklist.map(c => c.kind)).toEqual(['dep_inferred', 'dep_inferred', 'mission_local']);
    expect(d.redLines).toHaveLength(1);
    expect(d.redLines[0]).toContain('Migration numbering stays serialized');
    expect(d.stillEnforced[0]).toContain('2 files in core/db');
    expect(d.risk).toBe('core/db overlap · declared files');
  });

  it('refusal body: a declared dependency in the set means no force is offered and says why', () => {
    const body = coordinationHoldBody([migrationEdge('a'), r('dep_declared', 'z')]);
    expect(body.canForce).toBe(false);
    expect(body.force).toBeNull();
    expect(body.notForceable).toEqual(['Declared dependency']);
    const ok = coordinationHoldBody([migrationEdge('a'), r('mission_local', 'm')]);
    expect(ok.canForce).toBe(true);
    expect(ok.force?.kinds?.sort()).toEqual(['dep_inferred', 'mission_local']);
  });

  it('digest is order-insensitive and changes with the blocker', () => {
    const a = waitingReasonsDigest([r('pr_overlap_live', '3818'), r('mission_concurrent', 'm')]);
    expect(waitingReasonsDigest([r('mission_concurrent', 'm'), r('pr_overlap_live', '3818')])).toBe(a);
    expect(waitingReasonsDigest([r('pr_overlap_live', '3900'), r('mission_concurrent', 'm')])).not.toBe(a);
  });

  it('chip: held for coordination, ready for no runner, can\'t run for capability', () => {
    expect(waitingChip([r('pr_overlap_live')])).toBe('held');
    expect(waitingChip([r('eligible_no_runner')])).toBe('ready');
    expect(waitingChip([])).toBe('ready');
    expect(waitingChip([r('pr_overlap_live'), r('role_unavailable')])).toBe('cant_run');
    expect(waitingChip([r('dep_declared')])).toBe('blocked');
  });

  it('areas: container dirs two deep, schema dirs one more', () => {
    expect(areaOfPath('packages/core/db/schema.ts')).toBe('core/db');
    expect(areaOfPath('apps/web/src/app/page.tsx')).toBe('web');
    expect(areaOfPath('docs/specs/x.md')).toBe('docs');
    expect(areaOfPath('README.md')).toBe('README.md');
    expect(overlapAreas(['apps/web/a.ts', 'apps/web/b.ts', 'packages/core/db/schema.ts'])).toEqual([
      { area: 'web', count: 2 }, { area: 'core/db', count: 1 },
    ]);
  });

  it('readForceStart ignores malformed and expired intents', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const ok = { loopKeys: ['path_overlap'], expiresAt: '2026-10-07T12:10:00Z' };
    expect(readForceStart({ forceStart: ok }, now)).toMatchObject(ok);
    expect(readForceStart({ forceStart: { ...ok, expiresAt: '2026-10-07T11:59:00Z' } }, now)).toBeNull();
    expect(readForceStart({ forceStart: { expiresAt: ok.expiresAt } }, now)).toBeNull();
    expect(readForceStart(null, now)).toBeNull();
  });
});
