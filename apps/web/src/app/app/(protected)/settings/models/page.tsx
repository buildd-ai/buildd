import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamsWithDetails, resolveActiveTeamId } from '@/lib/team-access';
import ModelTiersClient from './ModelTiersClient';

export const dynamic = 'force-dynamic';

/**
 * Settings → Team → Agent backends → Model tiers.
 *
 * Tier → model mapping plus the team's chat provider keys. Everyone in the team
 * can see it; only owners and admins can change it (the APIs enforce the same
 * rule, this only decides which controls render). Chat links its setup card
 * here: `/app/settings/models#provider-keys`.
 */
export default async function ModelTiersPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const cookieStore = await cookies();
  const [teamId, teams] = await Promise.all([
    resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value).catch(() => null),
    getUserTeamsWithDetails(user.id).catch(() => []),
  ]);
  const team = teams.find((t) => t.id === teamId) ?? null;
  const isAdmin = team?.role === 'owner' || team?.role === 'admin' || team?.slug === `personal-${user.id}`;

  return (
    <main className="min-h-screen pt-4 px-4 pb-24 md:p-8 md:pb-8">
      <div className="max-w-6xl mx-auto">
        {teamId ? (
          <ModelTiersClient teamId={teamId} teamName={team?.name ?? null} isAdmin={isAdmin} />
        ) : (
          <p className="text-sm text-text-secondary">Join or create a team to set up model tiers.</p>
        )}
      </div>
    </main>
  );
}
