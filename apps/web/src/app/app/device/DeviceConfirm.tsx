import type { DeviceConfirmDetails } from '@/lib/device-confirm';

function formatRequested(iso: string): string {
  const d = new Date(iso);
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000));
  const ago = mins < 1 ? 'just now' : mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  return `${ago} (${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
}

/**
 * Shows a pending device code. Nothing here runs on render or mount: the code
 * arriving pre-filled in the URL is never enough to approve it. "Choose
 * workspaces" opens the runner consent page for the code
 * (/api/auth/device/consent), where the person picks the workspaces, across
 * their teams, the runner claims from; only its Connect runner approves.
 */
export default function DeviceConfirm({ details }: { details: DeviceConfirmDetails }) {
  const consentHref = `/api/auth/device/consent?code=${encodeURIComponent(details.userCode)}`;

  const target = details.accountEmail || 'your account';

  return (
    <div data-testid="device-confirm">
      <p className="text-text-secondary text-sm mb-4">
        A device is asking to sign in to buildd as you. Check the details below.
      </p>

      <dl className="mb-4 border border-border-default rounded-lg divide-y divide-border-default text-sm">
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-text-muted whitespace-nowrap shrink-0">Code</dt>
          <dd data-testid="device-confirm-code" className="font-mono tracking-widest text-text-primary">
            {details.userCode}
          </dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-text-muted whitespace-nowrap shrink-0">Device</dt>
          <dd data-testid="device-confirm-client" className="text-text-primary text-right break-words">
            {details.clientName}
          </dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-text-muted whitespace-nowrap shrink-0">Requested</dt>
          <dd data-testid="device-confirm-requested" className="text-text-primary text-right" suppressHydrationWarning>
            {formatRequested(details.requestedAt)}
          </dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-text-muted whitespace-nowrap shrink-0">Signed in as</dt>
          <dd data-testid="device-confirm-target" className="text-text-primary text-right break-words">
            {target}
          </dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-text-muted whitespace-nowrap shrink-0">Access</dt>
          <dd className="text-text-primary">up to {details.level}</dd>
        </div>
      </dl>

      <div className="mb-4 bg-status-warning/10 border border-status-warning/20 rounded-lg p-3 text-sm text-text-primary">
        Continue only if you started this sign-in yourself, just now, and the code matches your terminal.
        If you did not, press Cancel.
      </div>

      <div className="flex flex-col gap-2">
        <a
          href={consentHref}
          data-testid="device-confirm-approve"
          className="w-full px-4 py-3 text-center bg-primary text-white font-medium rounded-md hover:bg-primary-hover transition-colors"
        >
          Choose workspaces
        </a>
        <a
          href="/app/home"
          data-testid="device-confirm-cancel"
          className="w-full px-4 py-3 text-center border border-border-default text-text-secondary font-medium rounded-md hover:bg-surface-3 transition-colors"
        >
          Cancel
        </a>
      </div>
    </div>
  );
}
