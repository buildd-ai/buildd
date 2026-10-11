import UrlSheet from '@/components/UrlSheet';
import { LandingActionConfirm, LandingTapResult } from '@/components/LandingActionConfirm';
import { primaryActionClass } from '@/components/ui/PrimaryAction';
import { PR_ACTION_SHEET } from '@/modules';
import { PR_SHEET_KEYS } from './pr-sheet';

/**
 * A PR's landing actions (merge anyway, fix CI, resolve conflicts…), a sheet
 * over Home at `?pr=<n>&t=<token>`. The push alert links here; the old
 * /app/prs/:n/act redirects here with its query. Sign-in is Home's job: it
 * sends a signed-out reader back to this same URL.
 */
export default async function PrActionSheet({ prNumber, token, userId }: { prNumber: number; token: string | undefined; userId: string }) {
  const view = await PR_ACTION_SHEET({ prNumber, token, userId });

  return (
    <UrlSheet title="Pull request" keys={PR_SHEET_KEYS} testId="landing-action-page">
      <p className="font-mono text-meta text-text-muted">PR #{prNumber}</p>

      {view.state === 'ready' ? (
        <>
          {view.headMoved && (
            <p className="mt-3 border border-border-default bg-surface-2 p-3 text-sm text-text-secondary" data-testid="landing-action-head-moved">
              New commits arrived since this alert. Confirming re-runs landing against the current commit instead of acting on old advice.
            </p>
          )}
          <LandingActionConfirm
            prNumber={prNumber}
            workspaceId={view.workspaceId}
            token={view.token}
            proposed={view.proposed}
            options={view.options}
            headMoved={view.headMoved}
            fallbackHref={view.fallbackHref}
            heading={view.heading}
            prUrl={view.prUrl}
          />
        </>
      ) : view.state === 'already_done' ? (
        <LandingTapResult view={view.result} taskHref={view.fallbackHref} prUrl={view.prUrl} />
      ) : (
        <>
          <h1 className="mt-1 font-mono text-xl font-bold text-text-primary">
            {view.state === 'expired' ? 'This link has expired' : view.state === 'mismatch' ? 'This link is for another PR' : 'This link is not valid'}
          </h1>
          <p className="mt-3 text-sm text-text-secondary" data-testid="landing-action-fallback">
            Alert links are single use and last a day. The PR&apos;s current state, with its own actions, is on its task page.
          </p>
          {/* A plain anchor: a full navigation always lands from an in-app browser. */}
          <a href={view.fallbackHref} className={primaryActionClass({ className: 'mt-4' })}>
            See current state
          </a>
        </>
      )}
    </UrlSheet>
  );
}
