import Link from 'next/link';

/**
 * "Team: <name> · Switch" for a settings page that shows one team at a time
 * (Members, Runners). Each other team links to the same page with `?team=<id>`.
 * With no other team it is the team's name alone, so the page still says whose
 * it is.
 */
export default function TeamSwitcher({
  shown,
  others,
  basePath,
}: {
  shown: { name: string };
  others: Array<{ id: string; name: string; role: string }>;
  /** The page each team links to, e.g. `/app/settings/runners`. */
  basePath: string;
}) {
  if (others.length === 0) {
    return (
      <p data-testid="team-switcher" className="min-w-0 flex-1 text-sm text-text-secondary">
        <span className="text-text-muted">Team:</span>{' '}
        <span className="font-medium text-text-primary">{shown.name}</span>
      </p>
    );
  }
  return (
    <details data-testid="team-switcher" className="group min-w-0 flex-1 text-sm">
      <summary className="flex min-h-11 md:min-h-0 cursor-pointer list-none items-center gap-1.5 text-text-secondary">
        <span className="text-text-muted">Team:</span>
        <span className="font-medium text-text-primary">{shown.name}</span>
        <span aria-hidden="true">·</span>
        <span className="underline underline-offset-2 hover:text-text-primary">Switch</span>
      </summary>
      <div className="mt-2 divide-y divide-border-default border-y border-border-default">
        {others.map((t) => (
          <Link
            key={t.id}
            href={`${basePath}?team=${encodeURIComponent(t.id)}`}
            className="flex min-h-11 items-center justify-between gap-3 py-2 hover:bg-surface-3 transition-colors"
          >
            <span className="truncate font-medium text-text-primary">{t.name}</span>
            <span className="shrink-0 text-text-muted">{t.role}</span>
          </Link>
        ))}
      </div>
    </details>
  );
}
