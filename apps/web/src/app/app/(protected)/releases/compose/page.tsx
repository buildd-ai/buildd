import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { releaseCandidatePolicy } from '@buildd/core/release-candidate';
import { and, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Notice from '@/components/ui/Notice';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isGitHubAppConfigured } from '@/lib/github';
import { teamIdsWhere } from '@/lib/permissions';
import { composeHref } from '@/lib/release/compose-href';
import { loadFlowFor, resolveComposeTarget } from '@/lib/release/compose-runtime';
import { resolveActiveTeamId } from '@/lib/team-access';
import ReleaseFlow from './ReleaseFlow';

export const dynamic = 'force-dynamic';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 sm:px-7 md:px-10 pt-4 md:pt-8 pb-10 max-w-3xl">
      <Link href="/app/releases" className="text-meta text-text-muted underline-offset-2 hover:underline">Releases</Link>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/**
 * The owner's release flow: Compose → Cut → Review → Release
 * (lib/release/compose-*.ts). Owners and admins only; reached from the
 * Releases page's Next release card and the Plan view's release cut line.
 */
export default async function ComposeReleasePage({ searchParams }: { searchParams: Promise<{ workspace?: string }> }) {
  const { workspace: wsParam } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await teamIdsWhere({ kind: 'user', userId: user.id }, 'manage_releases');
  if (teamIds.length === 0) {
    return <Shell><p className="text-body text-text-secondary">Only a team owner or admin can run a release.</p></Shell>;
  }
  const cookieStore = await cookies();
  const activeTeamId = await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value);
  const scope = activeTeamId && teamIds.includes(activeTeamId) ? [activeTeamId] : teamIds;
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, releaseConfig: workspaces.releaseConfig })
    .from(workspaces)
    .where(and(inArray(workspaces.teamId, scope), wsParam ? eq(workspaces.id, wsParam) : undefined));
  const eligible = rows.filter((w) => w.releaseConfig?.enabled === true && releaseCandidatePolicy(w.releaseConfig));
  if (eligible.length === 0) {
    return (
      <Shell>
        <p className="text-body text-text-secondary">
          No workspace here cuts frozen release candidates. Turn them on in a workspace&apos;s release settings.
        </p>
      </Shell>
    );
  }
  if (!wsParam && eligible.length === 1) redirect(composeHref(eligible[0].id));
  if (!wsParam) {
    return (
      <Shell>
        <p className="text-body text-text-secondary">Pick a workspace to release.</p>
        <div className="mt-3 border-t border-border-default">
          {eligible.map((w) => (
            <Link key={w.id} href={composeHref(w.id)} className="flex min-h-11 items-center border-b border-border-default text-body text-text-primary underline-offset-2 hover:underline">
              {w.name}
            </Link>
          ))}
        </div>
      </Shell>
    );
  }
  if (!isGitHubAppConfigured()) {
    return <Shell><Notice tone="err">The GitHub App is not configured on this buildd instance, so releases cannot be read or cut.</Notice></Shell>;
  }

  const target = await resolveComposeTarget(user.id, wsParam);
  if (!target.ok) return <Shell><Notice tone="err">{target.error}</Notice></Shell>;
  let flow;
  try {
    flow = await loadFlowFor(target.target);
  } catch (e) {
    return <Shell><Notice tone="err">Could not read the release from GitHub: {e instanceof Error ? e.message : String(e)}</Notice></Shell>;
  }
  if (!flow.ok) return <Shell><Notice tone="err">{flow.error}</Notice></Shell>;
  return (
    <Shell>
      <ReleaseFlow view={flow.view} />
    </Shell>
  );
}
