import Link from 'next/link';

/** Release settings sit in the workspace settings' Delivery section. */
export function releaseSettingsHref(workspaceId: string): string {
  return `/app/settings/workspace/${workspaceId}#delivery`;
}

const ROW = 'flex min-h-11 items-center justify-between gap-3 border-b border-border-default text-body text-text-primary underline-offset-2 hover:underline';

/**
 * The release flow's empty state: no workspace in scope cuts frozen release
 * candidates. Each workspace links to the settings that turn them on.
 */
export default function NoCandidateWorkspaces({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  return (
    <div data-testid="release-flow-not-enabled">
      <h1 className="text-xl font-semibold text-text-primary">Compose a release</h1>
      <p className="mt-2 text-body text-text-secondary">
        No workspace here cuts frozen release candidates yet. Turn on Release candidates in a workspace&apos;s release settings, under Delivery.
      </p>
      <div className="mt-4 border-t border-border-default">
        {workspaces.length > 0 ? (
          workspaces.map((w) => (
            <Link key={w.id} href={releaseSettingsHref(w.id)} className={ROW}>
              <span className="truncate">{w.name}</span>
              <span className="shrink-0 text-meta text-text-muted">Release settings ›</span>
            </Link>
          ))
        ) : (
          <Link href="/app/settings/workspaces" className={ROW}>
            <span>Workspace settings ›</span>
          </Link>
        )}
      </div>
    </div>
  );
}
