/**
 * A runner's probe of a provider wall it holds claims behind.
 *
 * The wall is recorded from a real limit error (`backend_pauses`, the account's
 * budget flag) with the reset time the provider quoted. Capacity can come back
 * before that time (a plan upgrade, a switched account, a top-up) and nothing
 * on the server can see the runner's login, so the runner probes and reports.
 *
 *  - `capacity`: the probe ran on the runner's own credential and succeeded.
 *    The wall is cleared: this seat's pause rows (and shared ones, which a
 *    runner login is the likeliest cause of) expire now and the account flag is
 *    dropped. The next real limit error records the wall again, so a mistaken
 *    clear costs at most one failed attempt per slot.
 *  - `limited`: still at the limit. The wall stays; its reset time is replaced
 *    by the one the probe's error quoted (never moved earlier than now).
 *  - `error`: the probe could not tell (network, auth). Nothing changes.
 *
 * Every capacity/limited result is one gate-ledger row (`budget_wall_probe`).
 */
import { db } from '@buildd/core/db';
import { accounts, backendPauses } from '@buildd/core/db/schema';
import { and, eq, gt, isNull, or, inArray } from 'drizzle-orm';
import { recordGateEvent, GATE_SLUGS } from '@buildd/core/gate-events';
import { recordBackendPause } from './backend-failover';
import { callerSeatKeys } from './runner-seat-wall';

export const BUDGET_PROBE_OUTCOMES = ['capacity', 'limited', 'error'] as const;
export type BudgetProbeOutcome = (typeof BUDGET_PROBE_OUTCOMES)[number];

/** Who or what asked for the probe. */
export const BUDGET_PROBE_TRIGGERS = ['auto', 'cli', 'nudge'] as const;
export type BudgetProbeTrigger = (typeof BUDGET_PROBE_TRIGGERS)[number];

export interface ApplyBudgetWallProbeInput {
  account: { id: string; teamId: string };
  backend: string;
  outcome: BudgetProbeOutcome;
  trigger: BudgetProbeTrigger;
  /** The reset time the limit error quoted (outcome `limited`). */
  resetsAt?: Date | null;
  runner?: string | null;
  claudeLoginId?: string | null;
  workspaceId?: string | null;
}

export interface ApplyBudgetWallProbeResult {
  outcome: BudgetProbeOutcome;
  /** Wall records (pause rows, account flag) this call expired. */
  cleared: number;
  /** The reset time now in force when the wall was kept. */
  resetsAt: string | null;
}

export async function applyBudgetWallProbe(input: ApplyBudgetWallProbeInput): Promise<ApplyBudgetWallProbeResult> {
  const { account, backend, outcome, trigger } = input;
  const now = new Date();
  const seatKeys = callerSeatKeys(input.runner, input.claudeLoginId) ?? [];
  const detail = { trigger, backend, outcome, probedAt: now.toISOString() };

  if (outcome === 'capacity') {
    const seatScope = seatKeys.length
      ? or(isNull(backendPauses.seatKey), inArray(backendPauses.seatKey, seatKeys))
      : isNull(backendPauses.seatKey);
    const expired = await db
      .update(backendPauses)
      .set({ resetsAt: now })
      .where(and(
        eq(backendPauses.teamId, account.teamId),
        eq(backendPauses.backend, backend as 'claude'),
        gt(backendPauses.resetsAt, now),
        seatScope,
      ))
      .returning({ id: backendPauses.id });
    let cleared = expired.length;
    if (backend === 'claude') {
      const flag = await db
        .update(accounts)
        .set({ budgetExhaustedAt: null, budgetResetsAt: null, budgetProbeRequestedAt: null })
        .where(and(eq(accounts.id, account.id), gt(accounts.budgetResetsAt, now)))
        .returning({ id: accounts.id });
      cleared += flag.length;
    }
    void recordGateEvent({
      gate: GATE_SLUGS.BUDGET_WALL_PROBE,
      surface: 'POST /api/runner/budget-wall',
      outcome: 'accepted',
      reason: `Budget wall cleared: ${backend} probe found capacity`,
      workspaceId: input.workspaceId ?? null,
      detail: { ...detail, cleared },
      callerOrigin: 'worker',
    });
    return { outcome, cleared, resetsAt: null };
  }

  if (outcome === 'limited') {
    const resetsAt = input.resetsAt && input.resetsAt > now ? input.resetsAt : null;
    if (resetsAt) {
      // Append-only log: the newest unexpired row wins, so a fresh row replaces the stale reset.
      await recordBackendPause({
        backend,
        scope: { teamId: account.teamId, workspaceId: input.workspaceId ?? null },
        resetsAt,
        seatKey: seatKeys[0] ?? null,
      });
      if (backend === 'claude') {
        await db
          .update(accounts)
          .set({ budgetResetsAt: resetsAt })
          .where(and(eq(accounts.id, account.id), gt(accounts.budgetResetsAt, now)));
      }
    }
    void recordGateEvent({
      gate: GATE_SLUGS.BUDGET_WALL_PROBE,
      surface: 'POST /api/runner/budget-wall',
      outcome: 'warned',
      reason: `Budget wall kept: ${backend} probe still at the limit`,
      workspaceId: input.workspaceId ?? null,
      detail: { ...detail, resetsAt: resetsAt?.toISOString() ?? null },
      callerOrigin: 'worker',
    });
    return { outcome, cleared: 0, resetsAt: resetsAt?.toISOString() ?? null };
  }

  return { outcome, cleared: 0, resetsAt: null };
}

/**
 * Ask every runner of a team to probe now. The request only raises a timestamp
 * the heartbeat hands back; the wall is cleared by a passing probe, nothing here.
 * Returns the number of accounts asked.
 */
export async function requestBudgetWallProbe(teamId: string, now = new Date()): Promise<number> {
  const asked = await db
    .update(accounts)
    .set({ budgetProbeRequestedAt: now })
    .where(eq(accounts.teamId, teamId))
    .returning({ id: accounts.id });
  return asked.length;
}
