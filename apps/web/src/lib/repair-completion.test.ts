import { describe, it, expect } from 'bun:test';
import { legacyRepairCompletionGate, legacyRepairOf, repairCompletionVerdict, type LegacyRepairGateDeps } from './repair-completion';

const HEAD = 'aaaaaaa1111111';
const open = (over: Record<string, unknown> = {}) => ({ state: 'open' as const, merged: false, headSha: HEAD, mergeableState: 'dirty', ...over });

describe('repairCompletionVerdict (spec workflow-state-kernel §13.11 rule 2)', () => {
  // Regression "zero-diff false success": the attempt started fresh from trunk,
  // pushed nothing, and the PR stayed dirty at the same head.
  it('refuses a conflict repair whose PR is still dirty at the bound head', () => {
    const v = repairCompletionVerdict({ kind: 'conflict', prNumber: 9, boundHeadSha: HEAD, live: open() });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('repair_still_conflicted');
  });

  it('refuses a moved head that is still dirty: someone else moving the head is not this repair', () => {
    const v = repairCompletionVerdict({ kind: 'conflict', prNumber: 9, boundHeadSha: HEAD, live: open({ headSha: 'bbbbbbb' }) });
    expect(v.ok).toBe(false);
  });

  it('allows an advanced head GitHub has not finished recomputing', () => {
    const v = repairCompletionVerdict({ kind: 'conflict', prNumber: 9, boundHeadSha: HEAD, live: open({ headSha: 'bbbbbbb', mergeableState: 'unknown' }) });
    expect(v).toEqual({ ok: true, evidence: 'head_advanced' });
  });

  it('allows an unmoved head only when GitHub verifies no repair is needed', () => {
    expect(repairCompletionVerdict({ kind: 'conflict', prNumber: 9, boundHeadSha: HEAD, live: open({ mergeableState: 'clean' }) }))
      .toEqual({ ok: true, evidence: 'no_repair_needed' });
    const unknown = repairCompletionVerdict({ kind: 'conflict', prNumber: 9, boundHeadSha: HEAD, live: open({ mergeableState: 'unknown' }) });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('repair_not_advanced');
  });

  it('migration: refuses while the collision holds, allows when it is gone at the same head', () => {
    const still = repairCompletionVerdict({ kind: 'migration', prNumber: 9, boundHeadSha: HEAD, live: open({ mergeableState: 'clean', headSha: 'ccc' }), collisionPresent: true });
    expect(still.ok).toBe(false);
    if (!still.ok) expect(still.code).toBe('repair_still_colliding');
    expect(repairCompletionVerdict({ kind: 'migration', prNumber: 9, boundHeadSha: HEAD, live: open({ mergeableState: 'clean' }), collisionPresent: false }))
      .toEqual({ ok: true, evidence: 'no_repair_needed' });
  });

  it('fails open when GitHub is unreadable, and allows a closed or merged PR', () => {
    expect(repairCompletionVerdict({ kind: 'conflict', prNumber: 9, boundHeadSha: HEAD, live: null }).ok).toBe(true);
    expect(repairCompletionVerdict({ kind: 'conflict', prNumber: 9, boundHeadSha: HEAD, live: open({ merged: true }) }).ok).toBe(true);
  });
});

describe('legacyRepairOf', () => {
  it('ignores kernel-owned attempts, semantic reviews and splits', () => {
    expect(legacyRepairOf({ deliveryId: 'd', conflictRetryPrNumber: 1 })).toBeNull();
    expect(legacyRepairOf({ conflictRetryPrNumber: 1, context: { failureContext: { errorType: 'semantic_conflict' } } })).toBeNull();
    expect(legacyRepairOf({ conflictRetryPrNumber: null })).toBeNull();
  });
  it('reads kind and bound head', () => {
    expect(legacyRepairOf({ conflictRetryPrNumber: 4, context: { failureContext: { errorType: 'migration_collision', headSha: 'h1' } } }))
      .toEqual({ kind: 'migration', prNumber: 4, boundHeadSha: 'h1' });
    expect(legacyRepairOf({ conflictRetryPrNumber: 4, conflictRetryHeadSha: 'h2' }))
      .toEqual({ kind: 'conflict', prNumber: 4, boundHeadSha: 'h2' });
  });
});

describe('legacyRepairCompletionGate', () => {
  const deps = (live: ReturnType<typeof open> | null, collision: boolean | null = null): LegacyRepairGateDeps & { reads: number } => {
    const d = {
      reads: 0,
      repoFor: async () => ({ installationId: 1, repoFullName: 'acme/app' }),
      readPr: async () => { d.reads++; return live ? { headRepoFullName: null, baseRef: 'dev', ...live } : null; },
      collisionAt: async () => collision,
    };
    return d;
  };
  const task = { workspaceId: 'ws', conflictRetryPrNumber: 9, context: { failureContext: { errorType: 'merge_conflict', headSha: HEAD } } };

  it('refuses the zero-diff completion of a legacy conflict retry', async () => {
    const r = await legacyRepairCompletionGate({ task, localHeadSha: null }, deps(open()));
    expect(r?.code).toBe('repair_still_conflicted');
  });

  it('allows once the repair is on the PR', async () => {
    expect(await legacyRepairCompletionGate({ task, localHeadSha: 'bbb' }, deps(open({ headSha: 'bbb', mergeableState: 'clean' })))).toBeNull();
  });

  it('does not read GitHub for a task that is not a legacy repair', async () => {
    const d = deps(open());
    expect(await legacyRepairCompletionGate({ task: { workspaceId: 'ws', conflictRetryPrNumber: null }, localHeadSha: null }, d)).toBeNull();
    expect(d.reads).toBe(0);
  });

  it('migration collision still present refuses even with a moved head', async () => {
    const t = { workspaceId: 'ws', conflictRetryPrNumber: 9, context: { failureContext: { errorType: 'migration_collision', headSha: HEAD } } };
    const r = await legacyRepairCompletionGate({ task: t, localHeadSha: null }, deps(open({ headSha: 'moved', mergeableState: 'clean' }), true));
    expect(r?.code).toBe('repair_still_colliding');
  });
});
