/**
 * The event doors of `Buildd / Review approval` on an open PR head (docs/specs/workflow-kernel-library.md
 * §4, AC-39): GitHub webhooks (a PR opened or pushed, a check suite or run finished), a stored review
 * request and a recorded review verdict call here (through `republishPrHeads` in apps/web/src/modules.ts),
 * so the status follows the event instead of waiting for the hourly floor. Each call derives the answer
 * from what is true now (`publishOpenPrHead`), so a late or duplicate event is harmless. A failure here
 * never fails the event it rides on: the floor repeats it within the hour.
 *
 * `candidatesOnly`: the event can only move a release candidate's answer (a check finished, a review was
 * asked for); every other PR's answer does not read checks, so it is skipped before any GitHub call.
 */
import { publishOpenPrHead } from './open-pr-status';

export interface PrHeadEvent {
  number: number;
  sha?: string | null;
  /** The payload's branches, when it has them: a PR whose branches are not candidate-shaped is skipped unread. */
  headRef?: string | null;
  baseRef?: string | null;
}

export async function republishPrHeads(
  installationId: number | undefined,
  repoFullName: string | undefined,
  prs: ReadonlyArray<PrHeadEvent>,
  opts: { candidatesOnly?: boolean; publish?: typeof publishOpenPrHead } = {},
): Promise<void> {
  if (!installationId || !repoFullName) return;
  const publish = opts.publish ?? publishOpenPrHead;
  for (const pr of prs) {
    try {
      await publish({
        installationId, repoFullName, prNumber: pr.number, sha: pr.sha ?? null,
        ...(opts.candidatesOnly ? { candidatesOnly: true, headRef: pr.headRef, baseRef: pr.baseRef } : {}),
      });
    } catch (err) {
      console.error(`[workflow] open PR status for ${repoFullName}#${pr.number} failed (the floor repeats it):`, err);
    }
  }
}
