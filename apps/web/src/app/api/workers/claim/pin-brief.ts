/**
 * The Living Spec pin on a claimed task, for the agent and the approvers
 * (lib/specs/task-handoff.ts, living-specs.md §20 R-82, R-83):
 *
 * - the brief rides the resolvedContextProviders rail, so the agent knows the
 *   revision it builds and, when it is provisional, to build and not ask;
 * - a provisional pin's first claim asks the approvers once, through the
 *   existing approval push (each approver's own Pushover key) pointing at the
 *   existing inbox, where Home's Needs you card already counts it. Nothing
 *   else is sent: a team with no personal key set up gets the card only.
 *
 * Runs after the claim stands, over the claimed workers only. Best-effort.
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import { appendContextBlock, type ContextBlockSink } from './context-injection';

export type SpecPinAtClaim = {
  brief: string | null;
  ask: { specId: string; revision: number; title: string } | null;
  workspaceId: string;
};

export type ApprovalAsk = { workspaceId: string; specId: string; revision: number; title: string };

// The approvers are asked when the revision is written (lib/specs/store.ts
// requestApproval), not when a task claims it: nothing more to send here.
const defaultAsk = async (_a: ApprovalAsk): Promise<void> => {};

export function attachSpecPinBriefs(
  claimedWorkers: ClaimTasksResponse['workers'],
  pins: ReadonlyMap<string, SpecPinAtClaim>,
  sink: ContextBlockSink = appendContextBlock,
  ask: (a: ApprovalAsk) => Promise<unknown> = defaultAsk,
): void {
  for (const cw of claimedWorkers) {
    const pin = pins.get(cw.taskId);
    if (!pin) continue;
    if (pin.brief) sink(cw, pin.brief);
    if (pin.ask) {
      void ask({ workspaceId: pin.workspaceId, ...pin.ask }).catch((err) => {
        console.warn(`[claim] approval ask for spec ${pin.ask!.specId} failed (the inbox still lists it):`, (err as Error)?.message ?? err);
      });
    }
  }
}
