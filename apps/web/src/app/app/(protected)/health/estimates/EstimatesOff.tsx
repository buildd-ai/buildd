import Link from 'next/link';

export const FEATURES_SETTINGS_HREF = '/app/settings/features';

/**
 * Health › Estimates when the team has estimates off. Someone who can change it
 * gets the way to turn it on; everyone else learns who can.
 */
export function EstimatesOff({ canManage, defaultOffReason }: { canManage: boolean; defaultOffReason: string | null }) {
  return (
    <div className="py-3 space-y-2" data-testid="estimates-off">
      <p className="text-title font-semibold text-text-primary">Task estimates are off for this team.</p>
      <p className="text-body text-text-muted max-w-prose">
        When they are on, each new task records how long it will likely take, and this page shows how close those
        estimates came to the real time.
      </p>
      {defaultOffReason && <p className="text-meta text-text-muted max-w-prose">{defaultOffReason}</p>}
      {canManage ? (
        <Link href={FEATURES_SETTINGS_HREF} className="btn btn-sm h-11 md:h-8 inline-flex items-center" data-testid="estimates-turn-on">
          Turn on in Settings
        </Link>
      ) : (
        <p className="text-body text-text-muted" data-testid="estimates-ask-admin">
          A team owner or admin can turn them on in{' '}
          <Link href={FEATURES_SETTINGS_HREF} className="text-accent-text hover:underline">Settings › Features</Link>.
        </p>
      )}
    </div>
  );
}
