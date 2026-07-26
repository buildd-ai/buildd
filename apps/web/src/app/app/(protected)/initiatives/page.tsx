import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { loadInitiativeList } from '@/lib/initiative-list';
import { sortInitiatives } from '@/lib/initiative-presentation';
import InitiativeCard from '@/components/InitiativeCard';

export const dynamic = 'force-dynamic';

export default async function InitiativesListPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  const initiatives = sortInitiatives(await loadInitiativeList({ teamIds }));

  // Empty-collapse: with zero initiatives the page is pure absence — no list
  // chrome, just a single prompt to start the first one (spec safety property).
  if (initiatives.length === 0) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-5xl">
        <div className="card p-8 text-center max-w-md mx-auto mt-10">
          <p className="text-sm text-text-secondary mb-1">No initiatives yet.</p>
          <p className="text-xs text-text-muted mb-4">
            Group related missions under a durable arc to track cumulative progress.
          </p>
          <Link
            href="/app/initiatives/new"
            className="inline-block px-3 py-1.5 text-[12px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors"
          >
            + New initiative
          </Link>
        </div>
      </div>
    );
  }

  const blockedCount = initiatives.filter((i) => i.progress.status === 'blocked').length;

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary font-sans uppercase tracking-tight">Initiatives</h1>
          <p className="text-[12px] text-text-muted mt-1">
            {initiatives.length} open{blockedCount > 0 ? ` · ${blockedCount} blocked` : ''} · progress rolled up from missions and tasks
          </p>
        </div>
        <Link
          href="/app/initiatives/new"
          className="shrink-0 px-2.5 py-1 text-[11px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors"
        >
          + New initiative
        </Link>
      </div>

      <div className="flex flex-col gap-3">
        {initiatives.map((initiative) => (
          <InitiativeCard key={initiative.id} initiative={initiative} />
        ))}
      </div>
    </div>
  );
}
