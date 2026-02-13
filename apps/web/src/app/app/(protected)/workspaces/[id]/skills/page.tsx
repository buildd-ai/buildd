import { db } from '@buildd/core/db';
import { workspaces, skills } from '@buildd/core/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { SkillList } from './SkillList';
import { SkillForm } from './SkillForm';

export default async function SkillsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const showNew = query.new === '1';

  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  if (isDev) {
    return (
      <main className="min-h-screen p-8">
        <div className="max-w-4xl mx-auto">
          <p className="text-gray-500">Development mode - no database</p>
        </div>
      </main>
    );
  }

  if (!user) {
    redirect('/app/auth/signin');
  }

  const workspace = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, id), eq(workspaces.ownerId, user.id)),
    columns: { id: true, name: true },
  });

  if (!workspace) {
    notFound();
  }

  const workspaceSkills = await db.query.skills.findMany({
    where: eq(skills.workspaceId, id),
    orderBy: [desc(skills.createdAt)],
  });

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <Link href={`/app/workspaces/${id}`} className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
          &larr; {workspace.name}
        </Link>

        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">Skills</h1>
            <p className="text-gray-500 mt-1">
              {workspaceSkills.length} skill{workspaceSkills.length !== 1 ? 's' : ''} registered
            </p>
          </div>
          {!showNew && (
            <Link
              href={`/app/workspaces/${id}/skills?new=1`}
              className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
            >
              + Register Skill
            </Link>
          )}
        </div>

        {showNew && (
          <div className="mb-8">
            <SkillForm workspaceId={id} />
          </div>
        )}

        <SkillList
          workspaceId={id}
          initialSkills={JSON.parse(JSON.stringify(workspaceSkills))}
        />
      </div>
    </main>
  );
}
