import Link from 'next/link';
import SignOutButton from './SignOutButton';
import PersonalProviderKeys from './PersonalProviderKeys';
import SettingsPage from '../_components/SettingsPage';
import { loadSettingsContext } from '../_lib/settings-context';
import { getInitials } from './initials';

export const dynamic = 'force-dynamic';

/** Settings → Account → Profile (was /app/you; next.config redirects the old path). */
export default async function AccountSettingsPage() {
  const { user, teams, currentTeamId } = await loadSettingsContext();
  const initials = getInitials(user.name, user.email);

  return (
    <SettingsPage title="Profile">
      <section aria-labelledby="profile-h">
        <h2 id="profile-h" className="section-label mb-3">Signed in as</h2>
        <div className="card p-4">
          <div className="flex items-center gap-4">
            {user.image ? (
              <img src={user.image} alt={user.name || 'Avatar'} className="w-12 h-12 object-cover border border-border-default" />
            ) : (
              <div className="w-12 h-12 bg-accent-soft border border-border-default flex items-center justify-center">
                <span className="text-sm font-medium text-accent-text">{initials}</span>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-medium text-text-primary truncate">{user.name || 'Unnamed'}</p>
              <p className="text-xs text-text-secondary truncate">{user.email}</p>
            </div>
            <SignOutButton />
          </div>
        </div>
      </section>

      {/* Personal provider keys (chat). Wins over the team key for your turns. */}
      <PersonalProviderKeys
        teamId={currentTeamId}
        teamName={teams.find((t) => t.id === currentTeamId)?.name ?? null}
      />

      <section aria-labelledby="teams-h">
        <div className="flex justify-between items-center mb-3">
          <h2 id="teams-h" className="section-label">Your teams</h2>
          <Link href="/app/teams/new" className="text-sm text-text-secondary hover:text-text-primary transition-colors">
            New team
          </Link>
        </div>
        {teams.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-text-muted text-sm mb-3">No teams yet</p>
            <Link href="/app/teams/new" className="text-sm text-primary hover:underline">Create a team</Link>
          </div>
        ) : (
          <div className="card divide-y divide-border-default">
            {teams.map((team) => {
              const isPersonal = team.slug.startsWith('personal-');
              return (
                <Link
                  key={team.id}
                  href={`/app/teams/${team.id}`}
                  className="flex justify-between items-center gap-3 px-4 py-3 min-h-12 hover:bg-surface-3 transition-colors"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="font-medium truncate">{team.name}</span>
                    {isPersonal && <span className="status-pill status-pill-idle shrink-0">personal</span>}
                  </span>
                  <span className="flex items-center gap-3 text-xs shrink-0">
                    <span className="text-text-muted">
                      {team.memberCount} {team.memberCount === 1 ? 'member' : 'members'}
                    </span>
                    <span className="status-pill status-pill-idle">{team.role}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </SettingsPage>
  );
}
