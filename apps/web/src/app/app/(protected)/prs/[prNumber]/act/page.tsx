import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveOpenWorkerForUser } from '@/lib/pr-resolve';
import { verifyLandingActionToken, type LandingAction } from '@/lib/landing-action-token';
import { LANDING_ACTION_LABELS, plainReason } from '@/lib/pr-landing-alert';
import { loadLandingActionView } from '@/lib/landing-action-run';
import { taskPageHref, describeTapResult } from '@/lib/landing-action-view';
import { LandingActionConfirm, LandingTapResult } from '@/components/LandingActionConfirm';

export const dynamic = 'force-dynamic';

const ACTION_HINTS: Record<LandingAction, string> = {
  ci_fix: 'Files a task on the PR branch with the failing log digest.',
  conflict: 'Files a task that resolves the merge conflicts on the PR branch.',
  re_review: 'Asks the reviewer for a fresh verdict on the current commit.',
  retry_landing: 'Runs the landing check again with a fresh budget.',
  merge_anyway: 'Merges now, overriding the rule that stopped it.',
  close_superseded: 'Closes the PR; its change is already upstream.',
  review_on_github: 'buildd will not merge this one. Review the diff and merge it on GitHub yourself.',
};

export default async function LandingActionPage({
  params,
  searchParams,
}: {
  params: Promise<{ prNumber: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { prNumber: prNumberStr } = await params;
  const { t: token } = await searchParams;
  const prNumber = parseInt(prNumberStr, 10);
  if (!prNumber || Number.isNaN(prNumber)) redirect('/app/home');

  const user = await getCurrentUser();
  if (!user) {
    const here = `/app/prs/${prNumber}/act${token ? `?t=${encodeURIComponent(token)}` : ''}`;
    redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent(here)}`);
  }

  const verdict = token ? verifyLandingActionToken(token) : null;
  const workspaceHint = verdict?.ok ? verdict.payload.workspaceId : undefined;
  const resolved = await resolveOpenWorkerForUser(user.id, prNumber, workspaceHint);
  const worker = typeof resolved.status === 'number' ? null : (resolved as { id: string; taskId: string | null; workspaceId: string; prUrl: string | null });

  const view =
    token && worker?.taskId
      ? await loadLandingActionView({ token, workspaceId: worker.workspaceId, prNumber, taskId: worker.taskId })
      : ({ state: 'invalid' } as const);

  // The link's task only for a link that verified for this PR in the resolved workspace.
  const linkTaskId =
    verdict?.ok && worker && verdict.payload.prNumber === prNumber && verdict.payload.workspaceId === worker.workspaceId ? verdict.payload.taskId : null;
  const fallbackHref = taskPageHref(linkTaskId, worker?.taskId);

  return (
    <main className="mx-auto w-full max-w-xl p-4 sm:p-8" data-testid="landing-action-page">
      <p className="font-mono text-xs uppercase tracking-wide text-text-muted">PR #{prNumber}</p>

      {view.state === 'ready' && worker && token ? (
        <>
          {view.headMoved && (
            <p className="mt-3 border border-border-default bg-surface-2 p-3 text-sm text-text-secondary" data-testid="landing-action-head-moved">
              New commits arrived since this alert. Confirming re-runs landing against the current commit instead of acting on old advice.
            </p>
          )}
          <LandingActionConfirm
            prNumber={prNumber}
            workspaceId={worker.workspaceId}
            token={token}
            proposed={view.proposed}
            options={view.options.map((a) => ({
              action: a,
              label: LANDING_ACTION_LABELS[a],
              hint: ACTION_HINTS[a],
              ...(a === 'review_on_github' && worker.prUrl ? { href: `${worker.prUrl}/files` } : {}),
            }))}
            headMoved={view.headMoved}
            fallbackHref={fallbackHref}
            heading={`Won't land: ${plainReason(view.reason)}`}
            prUrl={worker.prUrl}
          />
        </>
      ) : view.state === 'already_done' ? (
        <LandingTapResult view={describeTapResult(view.result)} taskHref={fallbackHref} prUrl={worker?.prUrl} />
      ) : (
        <>
          <h1 className="mt-1 font-mono text-xl font-bold text-text-primary">
            {view.state === 'expired' ? 'This link has expired' : view.state === 'mismatch' ? 'This link is for another PR' : 'This link is not valid'}
          </h1>
          <p className="mt-3 text-sm text-text-secondary" data-testid="landing-action-fallback">
            Alert links are single use and last a day. The PR&apos;s current state, with its own actions, is on its task page.
          </p>
          {/* A plain anchor: a full navigation always lands from an in-app browser. */}
          <a href={fallbackHref} className="mt-4 inline-block bg-accent px-4 py-3 font-mono text-sm font-bold text-white">
            See current state
          </a>
        </>
      )}
    </main>
  );
}
