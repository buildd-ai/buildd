/**
 * §14, "Switch-off hands live deliveries to legacy" (docs/specs/workflow-state-kernel.md):
 * a delivery the kill switch released before its first round was queued is
 * legacy's, and legacy files a PR's first review only when the PR opens, a
 * moment that has passed. Legacy's first review runs now, once per owner
 * task, for an open PR in a workspace whose switch is still off (`Policy`).
 * A delivery released for any other reason (switch on) was handed over by a
 * legacy decision that already answered it.
 *
 * What legacy files is the host's (`HandOff.firstReview`); the once-per-owner
 * claim is too. Never throws: answers what it did, and gives the claim back
 * when the hand-off failed so the next owner end tries again.
 */
import { githubOf, type KernelPorts } from '../ports';
import type { DeliverySnapshot } from '../types';
import { hasPr, need } from './ports-of';

const RESOLVED_OR_CLOSED = new Set(['CLOSED_UNMERGED', 'SUPERSEDED', 'ABANDONED', 'MERGED']);

export async function handOffToLegacyOn(ports: KernelPorts, deliveryId: string, log: (msg: string, err: unknown) => void = () => {}): Promise<string> {
  let claimed: DeliverySnapshot | null = null;
  try {
    const view = await ports.store.loadView({ deliveryId });
    const d = view.delivery;
    if (!d || d.authority !== 'legacy') return 'not_released';
    if (!hasPr(d)) return 'no_pr';
    if (d.currentRound > 0 || view.rounds.length > 0) return 'already_reviewed';
    if (RESOLVED_OR_CLOSED.has(d.state)) return 'closed';
    const reader = await githubOf(ports, d.workspaceId);
    if (!reader) return 'no_repo';
    if ((await need(ports, 'policy', 'hand_off').forWorkspace(d.workspaceId)).kernelEnabled) return 'switch_on';
    const handOff = need(ports, 'handOff', 'hand_off');
    if (!(await handOff.claim(d))) return 'already_handed_off';
    claimed = d;
    const live = await reader.readPr(d.repoFullName, d.prNumber);
    if (!live) throw new Error('live_read_failed');
    if (live.state !== 'open' || live.merged) return 'pr_not_open';
    const r = await handOff.firstReview({
      d, headSha: live.headSha, baseRef: live.baseRef ?? d.baseRef,
      policyEvidence: d.policyEvidence ? { headSha: d.policyEvidence.headSha, outcome: d.policyEvidence.outcome, reason: d.policyEvidence.reason } : null,
    });
    return r.outcome;
  } catch (err) {
    // Let the next owner end try again rather than lose the review.
    if (claimed) await ports.handOff?.unclaim(claimed).catch(() => {});
    log(`[workflow] legacy hand-off of delivery ${deliveryId} failed:`, err);
    return 'error';
  }
}
