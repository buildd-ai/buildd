/**
 * The event doors of `Buildd / Review approval` on an open PR head (docs/specs/workflow-kernel-library.md
 * §4, AC-40, AC-42): GitHub webhooks (a PR opened or pushed, a check suite or run finished) and a
 * recorded review verdict call here, so the status follows the event instead of waiting for the hourly
 * floor. Each call derives the answer from what is true now (`publishOpenPrHead`), so a late or duplicate
 * event is harmless. A failure here never fails the event it rides on: the floor repeats it within the hour.
 */
import { publishOpenPrHead } from './open-pr-status';

export async function republishPrHeads(
  installationId: number | undefined,
  repoFullName: string | undefined,
  prs: ReadonlyArray<{ number: number; sha?: string | null }>,
  publish: typeof publishOpenPrHead = publishOpenPrHead,
): Promise<void> {
  if (!installationId || !repoFullName) return;
  for (const pr of prs) {
    try {
      await publish({ installationId, repoFullName, prNumber: pr.number, sha: pr.sha ?? null });
    } catch (err) {
      console.error(`[workflow] open PR status for ${repoFullName}#${pr.number} failed (the floor repeats it):`, err);
    }
  }
}
