import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamsWithDetails, resolveActiveTeamId } from '@/lib/team-access';
import ModelTiersClient from './ModelTiersClient';
import ChatTierPolicySection from './ChatTierPolicySection';
import ModelUpgradePolicySection from './ModelUpgradePolicySection';
import LegacyAnchorRedirect from '../_components/LegacyAnchorRedirect';
import { roleHas } from '@/lib/permission-registry';
import { getTeamPermissionOverrides } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

/**
 * Settings → AI → Model tiers.
 *
 * One table of tier x surface cells, the new-chat default as one row, then
 * the model-upgrade policy (how tiers move to newly certified models).
 * Everyone in the team can see it; only owners and admins can change it (the APIs enforce the same rule, this only decides which
 * controls render). Provider keys live at /app/settings/providers.
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
  const isAdmin = (!!team && roleHas(team.role, 'manage_model_tiers', await getTeamPermissionOverrides(team.id))) || team?.slug === `personal-${user.id}`;

  return (
    <main className="min-h-screen pt-14 px-4 pb-24 md:p-8 md:pb-8">
      <div className="max-w-6xl">
        {/* #provider-keys moved to Settings → Model providers. */}
        <LegacyAnchorRedirect />
        {teamId ? (
          <>
            <ModelTiersClient teamId={teamId} teamName={team?.name ?? null} isAdmin={isAdmin} />
            <ChatTierPolicySection teamId={teamId} isAdmin={isAdmin} />
            <ModelUpgradePolicySection teamId={teamId} isAdmin={isAdmin} />
          </>
        ) : (
          <p className="text-sm text-text-secondary">Join or create a team to set up model tiers.</p>
        )}
      </div>
    </main>
  );
}
