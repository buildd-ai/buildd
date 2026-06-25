import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamsWithDetails, type UserTeam } from '@/lib/team-access';
import SignOutButton from './SignOutButton';

export const dynamic = 'force-dynamic';

const roleColors: Record<string, string> = {
  owner: 'bg-primary/10 text-primary',
  admin: 'bg-status-info/10 text-status-info',
  member: 'bg-surface-3 text-text-primary',
};

function getInitials(name: string | null | undefined, email: string): string {
  if (name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  }
  return email[0].toUpperCase();
}

export default async function YouPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/app/auth/signin');
  }

  let userTeams: UserTeam[] = [];
  let teamsError = false;

  try {
    userTeams = await getUserTeamsWithDetails(user.id);
  } catch {
    teamsError = true;
  }

  const initials = getInitials(user.name, user.email);

  return (
    <main className="min-h-screen pt-14 px-4 pb-24 md:p-8 md:pb-8">
      <div className="max-w-2xl mx-auto space-y-10">

        {/* Profile */}
        <section>
          <h2 className="section-label mb-4">Profile</h2>
          <div className="card p-5">
            <div className="flex items-center gap-4">
              {user.image ? (
                <img
                  src={user.image}
                  alt={user.name || 'Avatar'}
                  className="w-12 h-12 rounded-full object-cover"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-sm font-medium text-primary">{initials}</span>
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

        {/* Teams */}
        <section>
          <div className="flex justify-between items-center mb-4">
            <h2 className="section-label">Teams</h2>
            <Link
              href="/app/teams/new"
              className="text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              + New Team
            </Link>
          </div>

          {teamsError ? (
            <div className="card p-6 text-center">
              <p className="text-text-muted text-sm">Failed to load teams</p>
            </div>
          ) : userTeams.length === 0 ? (
            <div className="card p-6 text-center">
              <p className="text-text-muted text-sm mb-3">No teams yet</p>
              <Link href="/app/teams/new" className="text-sm text-primary hover:underline">
                Create a team
              </Link>
            </div>
          ) : (
            <div className="card divide-y divide-border-default">
              {userTeams.map((team) => {
                const isPersonal = team.slug.startsWith('personal-');
                return (
                  <Link
                    key={team.id}
                    href={`/app/teams/${team.id}`}
                    className="block p-4 hover:bg-surface-3/50 transition-colors first:rounded-t-[10px] last:rounded-b-[10px]"
                  >
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-2 min-w-0">
                        <h3 className="font-medium truncate">{team.name}</h3>
                        {isPersonal && (
                          <span className="px-1.5 py-0.5 text-xs bg-surface-3 text-text-muted rounded flex-shrink-0">
                            Personal
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-sm flex-shrink-0">
                        <span className="text-text-muted">
                          {team.memberCount} {team.memberCount === 1 ? 'member' : 'members'}
                        </span>
                        <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${roleColors[team.role] || roleColors.member}`}>
                          {team.role}
                        </span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

      </div>
    </main>
  );
}
