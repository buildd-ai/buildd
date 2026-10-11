/**
 * What Home's PR action sheet shows (`/app/home?pr=<n>&t=<token>`, the push
 * alert's link; the old /app/prs/:n/act redirects there). Reads the signed
 * token, the PR's open worker and the landing view, and returns plain data so
 * the sheet in core renders it without importing this module
 * (it reaches it through `PR_ACTION_SHEET` in src/modules.ts).
 */
import { resolveOpenWorkerForUser } from '@/lib/pr-resolve';
import { verifyLandingActionToken, type LandingAction } from '@/lib/landing-action-token';
import { LANDING_ACTION_LABELS, plainReason } from '@/lib/pr-landing-alert';
import { loadLandingActionView } from '@/lib/landing-action-run';
import { taskPageHref, describeTapResult, type TapResultView } from '@/lib/landing-action-view';

const ACTION_HINTS: Record<LandingAction, string> = {
  ci_fix: 'Files a task on the PR branch with the failing log digest.',
  conflict: 'Files a task that resolves the merge conflicts on the PR branch.',
  re_review: 'Asks the reviewer for a fresh verdict on the current commit.',
  retry_landing: 'Runs the landing check again with a fresh budget.',
  merge_anyway: 'Merges now, overriding the rule that stopped it.',
  close_superseded: 'Closes the PR; its change is already upstream.',
  review_on_github: 'buildd will not merge this one. Review the diff and merge it on GitHub yourself.',
};

export interface PrSheetOption { action: string; label: string; hint: string; href?: string }

export type PrActionSheetView =
  | {
      state: 'ready';
      workspaceId: string;
      token: string;
      proposed: string;
      options: PrSheetOption[];
      headMoved: boolean;
      heading: string;
      prUrl: string | null;
      fallbackHref: string;
    }
  | { state: 'already_done'; result: TapResultView; prUrl: string | null; fallbackHref: string }
  | { state: 'expired' | 'mismatch' | 'invalid'; fallbackHref: string };

export async function loadPrActionSheet({ prNumber, token, userId }: { prNumber: number; token: string | undefined; userId: string }): Promise<PrActionSheetView> {
  const verdict = token ? verifyLandingActionToken(token) : null;
  const workspaceHint = verdict?.ok ? verdict.payload.workspaceId : undefined;
  const resolved = await resolveOpenWorkerForUser(userId, prNumber, workspaceHint);
  const worker = typeof resolved.status === 'number' ? null : (resolved as { id: string; taskId: string | null; workspaceId: string; prUrl: string | null });

  const view =
    token && worker?.taskId
      ? await loadLandingActionView({ token, workspaceId: worker.workspaceId, prNumber, taskId: worker.taskId })
      : ({ state: 'invalid' } as const);

  // The link's task only for a link that verified for this PR in the resolved workspace.
  const linkTaskId =
    verdict?.ok && worker && verdict.payload.prNumber === prNumber && verdict.payload.workspaceId === worker.workspaceId ? verdict.payload.taskId : null;
  const fallbackHref = taskPageHref(linkTaskId, worker?.taskId);

  if (view.state === 'ready' && worker && token) {
    return {
      state: 'ready',
      workspaceId: worker.workspaceId,
      token,
      proposed: view.proposed,
      options: view.options.map((a) => ({
        action: a,
        label: LANDING_ACTION_LABELS[a],
        hint: ACTION_HINTS[a],
        ...(a === 'review_on_github' && worker.prUrl ? { href: `${worker.prUrl}/files` } : {}),
      })),
      headMoved: view.headMoved,
      heading: `Won't land: ${plainReason(view.reason)}`,
      prUrl: worker.prUrl,
      fallbackHref,
    };
  }
  if (view.state === 'already_done') {
    return { state: 'already_done', result: describeTapResult(view.result), prUrl: worker?.prUrl ?? null, fallbackHref };
  }
  return { state: view.state === 'expired' || view.state === 'mismatch' ? view.state : 'invalid', fallbackHref };
}
