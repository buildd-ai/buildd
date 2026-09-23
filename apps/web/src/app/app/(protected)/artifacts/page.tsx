import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import ArtifactList from '@/components/ArtifactList';
import {
  loadArtifactsPage,
  parseArtifactLimit,
  ARTIFACTS_PAGE_SIZE,
  ARTIFACTS_MAX_LIMIT,
} from './load-artifacts';

export const dynamic = 'force-dynamic';

export default async function ArtifactsPage({
  searchParams,
}: {
  searchParams?: Promise<{ limit?: string | string[] }>;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  // Get all workspace IDs the user has access to
  const wsIds = await getUserWorkspaceIds(user.id);

  if (wsIds.length === 0) {
    return (
      <main className="min-h-screen pt-14 px-4 pb-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">Artifacts</h1>
          <p className="text-text-muted">No workspaces found. Create one to start collecting artifacts.</p>
        </div>
      </main>
    );
  }

  const limit = parseArtifactLimit((await searchParams)?.limit);
  const page = await loadArtifactsPage(wsIds, limit);
  const nextLimit = Math.min(limit + ARTIFACTS_PAGE_SIZE, ARTIFACTS_MAX_LIMIT);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';

  return (
    <main className="min-h-screen pt-14 px-4 pb-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Artifacts</h1>
            <p className="text-text-muted mt-1">
              {page.reviewCount} for review of {page.total} artifact{page.total !== 1 ? 's' : ''} across {page.workspaceCount} workspace{page.workspaceCount !== 1 ? 's' : ''}
              {page.hasMore && <> &middot; showing the {page.items.length} most recent</>}
            </p>
          </div>
        </div>

        <ArtifactList
          artifacts={page.items}
          showWorkspace
          showReviewFilter
          baseUrl={baseUrl}
        />

        {page.hasMore && limit < ARTIFACTS_MAX_LIMIT && (
          <div className="mt-6 flex justify-center">
            <Link
              href={`/app/artifacts?limit=${nextLimit}`}
              scroll={false}
              data-testid="artifacts-show-more"
              className="text-sm text-text-secondary hover:text-text-primary underline"
            >
              Show older artifacts
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
