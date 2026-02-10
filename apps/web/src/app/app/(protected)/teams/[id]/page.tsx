import { db } from '@buildd/core/db';
import { teams, teamMembers } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import TeamDetailClient from './TeamDetailClient';

export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  if (!isDev && !user) {
    redirect('/app/auth/signin');
  }

  if (isDev) {
    return (
      <main className="min-h-screen p-8">
        <div className="max-w-4xl mx-auto">
          <p className="text-gray-500">Dev mode - no team data</p>
        </div>
      </main>
    );
  }

  // Verify user is a member
  const membership = await db.query.teamMembers.findFirst({
    where: and(
      eq(teamMembers.teamId, id),
      eq(teamMembers.userId, user!.id)
    ),
  });

  if (!membership) {
    notFound();
  }

  const team = await db.query.teams.findFirst({
    where: eq(teams.id, id),
  });

  if (!team) {
    notFound();
  }

  const members = await db.query.teamMembers.findMany({
    where: eq(teamMembers.teamId, id),
    with: {
      user: true,
    },
  });

  const memberList = members.map(m => ({
    userId: m.userId,
    role: m.role as 'owner' | 'admin' | 'member',
    joinedAt: m.joinedAt.toISOString(),
    name: m.user.name,
    email: m.user.email,
    image: m.user.image,
  }));

  const isPersonal = team.slug.startsWith('personal-');
  const currentUserRole = membership.role as 'owner' | 'admin' | 'member';
  const canManage = currentUserRole === 'owner' || currentUserRole === 'admin';

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <Link href="/app/teams" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
          &larr; Teams
        </Link>

        <TeamDetailClient
          team={{
            id: team.id,
            name: team.name,
            slug: team.slug,
            createdAt: team.createdAt.toISOString(),
          }}
          members={memberList}
          currentUserRole={currentUserRole}
          currentUserId={user!.id}
          isPersonal={isPersonal}
          canManage={canManage}
        />
      </div>
    </main>
  );
}
