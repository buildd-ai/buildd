/**
 * The release doors' merge (docs/specs/workflow-kernel-library.md §4;
 * workflow-state-kernel.md §13.13 D7–D10): every release door takes the
 * review gate and merges only the head it verified.
 *
 *  1. The PR is read live. Already merged: that is the answer (a person or
 *     another door got there first). A head other than the verified one is
 *     refused, never merged unpinned (AC-16).
 *  2. A PR the kernel owns lands through the kernel (`land`), pinned to the
 *     verified head; the kernel's gate runs in its merge effect.
 *  3. Any other PR passes buildd's review gate at that head
 *     (`guardReviewVerdict`), then merges with GitHub's own `sha` pin, so a
 *     push between the read and the call is GitHub's refusal, not a merge.
 *
 * `verifiedHeadSha: null` means the door verified nothing of its own before
 * this call: the head read here is the one gated and pinned.
 */
import { githubApi } from '@/lib/github';
import { guardReviewVerdict } from '@/lib/review-verdict-gate';
import type { KernelOps } from '@/lib/workflow/kernel-client';

type LandingInput = KernelOps['land']['input'];
type KernelLanding = NonNullable<KernelOps['land']['result']>;

type Api = (installationId: number, path: string, options?: RequestInit) => Promise<any>;

export interface PinnedMergeInput {
  workspaceId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  /** The head the door verified (CI, the candidate); null = verify the live head here. */
  verifiedHeadSha: string | null;
  mergeMethod: 'merge' | 'squash' | 'rebase';
  /** Which door (recorded on the gate and the kernel transition). */
  surface: string;
  taskId?: string | null;
}

export type PinnedMergeResult =
  | { merged: true; sha: string | null; message: string; alreadyMerged?: boolean; via: 'kernel' | 'pinned' | 'github' }
  | { merged: false; message: string; refused: 'head_moved' | 'review' | 'kernel' | 'unreadable' | 'merge_failed'; headSha?: string | null };

export interface PinnedMergeDeps {
  api?: Api;
  reviewGate?: typeof guardReviewVerdict;
  /** The kernel's landing through the one client (kernel-client.ts); null = the kernel does not own the PR. */
  land?: (p: LandingInput) => Promise<KernelLanding | null>;
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 9) : 'unknown');

async function readPr(api: Api, p: PinnedMergeInput): Promise<{ merged?: boolean; state?: string; merge_commit_sha?: string | null; head?: { sha?: string } } | null> {
  try {
    return await api(p.installationId, `/repos/${p.repoFullName}/pulls/${p.prNumber}`);
  } catch {
    return null;
  }
}

export async function mergeReleasePrPinned(p: PinnedMergeInput, deps: PinnedMergeDeps = {}): Promise<PinnedMergeResult> {
  const api = deps.api ?? (githubApi as Api);
  const live = await readPr(api, p);
  if (live?.merged === true) {
    return { merged: true, sha: live.merge_commit_sha ?? null, message: `PR #${p.prNumber} already merged`, alreadyMerged: true, via: 'github' };
  }
  const liveHead = live?.head?.sha ?? null;
  if (!liveHead) return { merged: false, refused: 'unreadable', message: `could not read the live head of PR #${p.prNumber}; nothing was merged` };
  // AC-16: the head moved after the door verified it. Refused, never merged unpinned.
  if (p.verifiedHeadSha && liveHead !== p.verifiedHeadSha) {
    return {
      merged: false, refused: 'head_moved', headSha: liveHead,
      message: `PR #${p.prNumber} moved from ${short(p.verifiedHeadSha)} to ${short(liveHead)} after it was verified; nothing was merged`,
    };
  }
  const head = p.verifiedHeadSha ?? liveHead;

  const land = deps.land ?? (async (input: LandingInput) => (await import('@/lib/workflow/kernel-client')).landThroughKernel(input));
  const kernel = await land({
    workspaceId: p.workspaceId, installationId: p.installationId, repoFullName: p.repoFullName, prNumber: p.prNumber,
    headSha: head, door: `release:${p.surface}`, actor: `system:release:${p.surface}`, mergeMethod: p.mergeMethod,
  });
  if (kernel) {
    return kernel.merged
      ? { merged: true, sha: kernel.mergeCommitSha, message: kernel.message, via: 'kernel' }
      : { merged: false, refused: 'kernel', headSha: head, message: kernel.message };
  }

  const gate = await (deps.reviewGate ?? guardReviewVerdict)({
    workspaceId: p.workspaceId, prNumber: p.prNumber, headSha: head, surface: p.surface, taskId: p.taskId ?? null, callerOrigin: 'system',
  });
  if (gate.blocks) {
    return { merged: false, refused: 'review', headSha: head, message: `the review gate holds PR #${p.prNumber} at ${short(head)}: ${gate.reason ?? 'a review verdict blocks it'}` };
  }

  try {
    const res = await api(p.installationId, `/repos/${p.repoFullName}/pulls/${p.prNumber}/merge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // GitHub refuses (409) if the head is no longer the one gated here.
      body: JSON.stringify({ merge_method: p.mergeMethod, sha: head }),
    });
    if (res?.sha || res?.merged === true) return { merged: true, sha: (res.sha as string | undefined) ?? null, message: 'PR merged', via: 'pinned' };
    // An empty answer is not evidence of a merge: ask GitHub.
    const after = await readPr(api, p);
    if (after?.merged === true) return { merged: true, sha: after.merge_commit_sha ?? null, message: `PR #${p.prNumber} already merged`, alreadyMerged: true, via: 'github' };
    return { merged: false, refused: 'merge_failed', headSha: head, message: String(res?.message ?? 'merge failed') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The call failing does not mean the work is not in: a person or another door may have merged it.
    const after = await readPr(api, p);
    if (after?.merged === true) return { merged: true, sha: after.merge_commit_sha ?? null, message: `PR #${p.prNumber} already merged`, alreadyMerged: true, via: 'github' };
    const moved = /head branch was modified|409/i.test(msg) && after?.head?.sha && after.head.sha !== head;
    return { merged: false, refused: moved ? 'head_moved' : 'merge_failed', headSha: after?.head?.sha ?? head, message: msg };
  }
}
