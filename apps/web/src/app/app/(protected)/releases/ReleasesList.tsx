import Link from 'next/link';
import Card from '@/components/ui/Card';
import Eyebrow from '@/components/ui/Eyebrow';
import { composeHref } from '@/lib/release/compose-href';
import { ReleaseRow } from './ReleaseRow';
import { isSupersededRelease, pickNextRelease, releaseCountLine, supersededById } from './release-display';

type ListRelease = Parameters<typeof ReleaseRow>[0]['release'];

/** Everything the Releases list draws, read from the DB or from a `?state=` fixture (./releases-fixtures.ts). */
export interface ReleasesListData {
  /** Newest first, capped at the list limit. */
  releases: ListRelease[];
  /** The real total under the same scope; the list is capped, the count is not. */
  total: number;
  workspaces: Map<string, { name: string; gitConfig: any }>;
  metrics: Map<string, { taskCount: number; missionCount: number }>;
  /** Successor release id → its version, for superseded rows. */
  supersededVersions: Map<string, string | null>;
  /** The workspace whose release flow this person may open, if any. */
  composeWorkspaceId: string | null;
}

/** The page header: the shell's mobile header already says "Releases", so the h1 shows from md up only. */
export function ReleasesHeader({ countLine, composeLink }: { countLine?: string; composeLink?: string | null }) {
  return (
    <div className="mb-5">
      <h1 data-testid="releases-headline" className="sr-only md:not-sr-only text-xl font-semibold text-text-primary">Releases</h1>
      {countLine && <p data-testid="releases-count" className="font-mono text-meta text-text-muted md:mt-1">{countLine}</p>}
      {composeLink && (
        <Link data-testid="releases-compose" href={composeLink} className="mt-2 inline-flex min-h-11 items-center text-body text-text-primary underline-offset-2 hover:underline md:min-h-0">
          Compose the next release ›
        </Link>
      )}
    </div>
  );
}

export function ReleasesList({ releases: allReleases, total, workspaces: wsMap, metrics, supersededVersions, composeWorkspaceId }: ReleasesListData) {
  // The workspace name is the row's context only when the list spans several;
  // with one, the switcher already names it.
  const multiWorkspace = new Set(allReleases.map(r => r.workspaceId)).size > 1;

  function renderRow(release: ListRelease, bare = false) {
    const ws = wsMap.get(release.workspaceId);
    const gitConfig = ws?.gitConfig as any;
    const commitRangeUrl =
      gitConfig?.fullName && release.previousSha && release.headSha
        ? `https://github.com/${gitConfig.fullName}/compare/${release.previousSha}...${release.headSha}`
        : null;
    const successorId = isSupersededRelease(release) ? supersededById(release.failureReason) : null;
    const resolved = successorId != null && supersededVersions.has(successorId);
    return (
      <ReleaseRow
        key={release.id}
        release={release}
        workspaceName={multiWorkspace ? ws?.name ?? null : null}
        commitRangeUrl={commitRangeUrl}
        metrics={metrics.get(release.id) ?? { taskCount: 0, missionCount: 0 }}
        supersededByVersion={resolved ? supersededVersions.get(successorId) : null}
        supersededByReleaseId={resolved ? successorId : null}
        bare={bare}
      />
    );
  }

  const next = pickNextRelease(allReleases);
  const history = next ? allReleases.filter(r => r.id !== next.id) : allReleases;
  // The pending release's card carries the flow when its workspace cuts candidates.
  const nextCompose = next && composeWorkspaceId && next.workspaceId === composeWorkspaceId ? composeHref(next.workspaceId) : null;
  const headerCompose = composeWorkspaceId && !nextCompose ? composeHref(composeWorkspaceId) : null;

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 pb-10 max-w-3xl">
      <ReleasesHeader countLine={allReleases.length > 0 ? releaseCountLine(allReleases.length, total) : undefined} composeLink={headerCompose} />

      {allReleases.length === 0 ? (
        <p className="text-body text-text-secondary">No releases.</p>
      ) : (
        <>
          {/* The next release: the one L2 card on the page, everything below is
              L1 history. Its link opens the release flow (Compose → Cut →
              Review → Release, ./compose). */}
          {next && (
            <Card data-testid="next-release" className="mb-6 flex flex-col gap-2">
              <Eyebrow tone="muted">Next release</Eyebrow>
              {renderRow(next, true)}
              {nextCompose && (
                <Link data-testid="next-release-compose" href={nextCompose} className="inline-flex min-h-11 items-center text-body text-text-primary underline-offset-2 hover:underline md:min-h-0">
                  Review and release ›
                </Link>
              )}
            </Card>
          )}
          <div className="border-t border-border-default">
            {history.map(release => renderRow(release))}
          </div>
        </>
      )}
    </div>
  );
}
