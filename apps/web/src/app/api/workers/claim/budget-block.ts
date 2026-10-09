import type { ClaimBudgetWall, ClaimDiagnostics } from '@buildd/shared';

/**
 * The provider walls one claim request honoured, for the `budgetBlock` of a
 * budget_exhausted refusal. A refusal used to say only "budget_exhausted
 * (resets at X)", which could not tell a seat wall from a pause-log wall, nor
 * either from the learned forecast or a monthly cap (friction c0bb4d1f).
 */
export class BudgetWalls {
  private readonly walls = new Map<string, ClaimBudgetWall>();

  add(kind: ClaimBudgetWall['kind'], backend: ClaimBudgetWall['backend'], resetsAt: Date | string | null | undefined): void {
    const key = `${kind}:${backend}`;
    if (this.walls.has(key)) return;
    this.walls.set(key, { kind, backend, resetsAt: resetsAt ? new Date(resetsAt).toISOString() : null });
  }

  get size(): number {
    return this.walls.size;
  }

  block(): NonNullable<ClaimDiagnostics['budgetBlock']> {
    const walls = [...this.walls.values()];
    return { walls, override: budgetOverrideHint(walls) };
  }
}

/** What lifts the block: a provider wall is hard, so only its reset does. */
export function budgetOverrideHint(walls: ClaimBudgetWall[]): string {
  const parts = ['Provider walls are hard limits: force does not lift them, and they clear at resetsAt.'];
  if (walls.some(w => w.kind === 'account_seat' || w.kind === 'provider_pause')) {
    parts.push("They wall a runner's seat: claim_task {taskId} from your own session runs on your seat and is not held by them.");
  }
  if (walls.some(w => w.kind === 'tenant_budget')) {
    parts.push("A tenant budget wall clears at the tenant's reset.");
  }
  return parts.join(' ');
}
