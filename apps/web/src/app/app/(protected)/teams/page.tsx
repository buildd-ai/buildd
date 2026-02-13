import { db } from '@buildd/core/db';
import { teams, teamMembers } from '@buildd/core/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';

export const dynamic = 'force-dynamic';

interface TeamWithRole {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  role: string;
  memberCount: number;
}

export default async function TeamsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  let userTeams: TeamWithRole[] = [];

  try {
    const memberships = await db.query.teamMembers.findMany({
      where: eq(teamMembers.userId, user.id),
      with: {
        team: true,
      },
    });

    const validMemberships = memberships.filter(m => m.team != null);

    // Get member counts
    const teamIds = validMemberships.map(m => m.teamId);
    const memberCounts = teamIds.length > 0
      ? await db
          .select({
            teamId: teamMembers.teamId,
            count: sql<number>`count(*)::int`,
          })
          .from(teamMembers)
          .where(sql`${teamMembers.teamId} = ANY(${teamIds})`)
          .groupBy(teamMembers.teamId)
      : [];

    const countMap = new Map(memberCounts.map(mc => [mc.teamId, mc.count]));

    userTeams = validMemberships.map(m => ({
      id: m.team.id,
      name: m.team.name,
      slug: m.team.slug,
      createdAt: m.team.createdAt,
      role: m.role,
      memberCount: countMap.get(m.teamId) || 1,
    }));
  } catch (error) {
    console.error('Teams query error:', error);
  }

  const roleColors: Record<string, string> = {
    owner: 'bg-primary/10 text-primary',
    admin: 'bg-status-info/10 text-status-info',
    member: 'bg-surface-3 text-text-primary',
  };

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <Link href="/app/dashboard" className="text-sm text-text-secondary hover:text-text-primary mb-2 block">
              &larr; Dashboard
            </Link>
            <h1 className="text-3xl font-bold">Teams</h1>
            <p className="text-text-secondary">Manage your teams and collaborators</p>
          </div>
          <Link
            href="/app/teams/new"
            className="px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover"
          >
            + New Team
          </Link>
        </div>

        {userTeams.length === 0 ? (
          <div className="border border-dashed border-border-default rounded-lg p-12 text-center">
            <h2 className="text-xl font-semibold mb-2">No teams yet</h2>
            <p className="text-text-secondary mb-6">
              Create a team to collaborate with others
            </p>
            <Link
              href="/app/teams/new"
              className="px-6 py-3 bg-primary text-white rounded-md hover:bg-primary-hover"
            >
              Create Team
            </Link>
          </div>
        ) : (
          <div className="border border-border-default rounded-lg divide-y divide-border-default">
            {userTeams.map((team) => {
              const isPersonal = team.slug.startsWith('personal-');
              return (
                <Link
                  key={team.id}
                  href={`/app/teams/${team.id}`}
                  className="block p-4 hover:bg-surface-3"
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{team.name}</h3>
                        {isPersonal && (
                          <span className="px-1.5 py-0.5 text-xs bg-surface-3 text-text-secondary rounded">
                            Personal
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-text-secondary">{team.slug}</p>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <span className="text-text-secondary">
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
      </div>
    </main>
  );
}
