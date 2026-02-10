import { db } from '@buildd/core/db';
import { teams, teamMembers } from '@buildd/core/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';

interface TeamWithRole {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  role: string;
  memberCount: number;
}

export default async function TeamsPage() {
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  let userTeams: TeamWithRole[] = [];

  if (!isDev) {
    if (!user) {
      redirect('/app/auth/signin');
    }

    try {
      const memberships = await db.query.teamMembers.findMany({
        where: eq(teamMembers.userId, user.id),
        with: {
          team: true,
        },
      });

      // Get member counts
      const teamIds = memberships.map(m => m.teamId);
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

      userTeams = memberships.map(m => ({
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
  }

  const roleColors: Record<string, string> = {
    owner: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
    admin: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    member: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  };

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <Link href="/app/dashboard" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
              &larr; Dashboard
            </Link>
            <h1 className="text-3xl font-bold">Teams</h1>
            <p className="text-gray-500">Manage your teams and collaborators</p>
          </div>
          <Link
            href="/app/teams/new"
            className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
          >
            + New Team
          </Link>
        </div>

        {userTeams.length === 0 ? (
          <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-12 text-center">
            <h2 className="text-xl font-semibold mb-2">No teams yet</h2>
            <p className="text-gray-500 mb-6">
              Create a team to collaborate with others
            </p>
            <Link
              href="/app/teams/new"
              className="px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
            >
              Create Team
            </Link>
          </div>
        ) : (
          <div className="border border-gray-200 dark:border-gray-800 rounded-lg divide-y divide-gray-200 dark:divide-gray-800">
            {userTeams.map((team) => {
              const isPersonal = team.slug.startsWith('personal-');
              return (
                <Link
                  key={team.id}
                  href={`/app/teams/${team.id}`}
                  className="block p-4 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{team.name}</h3>
                        {isPersonal && (
                          <span className="px-1.5 py-0.5 text-xs bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 rounded">
                            Personal
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500">{team.slug}</p>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <span className="text-gray-500">
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
