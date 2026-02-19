import { db } from '@buildd/core/db';
import { workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { eq, desc } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { SkillList } from './SkillList';
import { SkillForm } from './SkillForm';
import { SkillInstall } from './SkillInstall';

export const dynamic = 'force-dynamic';

export default async function WorkspaceSkillsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const showNew = query.new === '1';

  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  const access = await verifyWorkspaceAccess(user.id, id);
  if (!access) notFound();

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { id: true, name: true },
  });

  if (!workspace) {
    notFound();
  }

  const skills = await db.query.workspaceSkills.findMany({
    where: eq(workspaceSkills.workspaceId, id),
    orderBy: [desc(workspaceSkills.createdAt)],
  });

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <Link href={`/app/workspaces/${id}`} className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
          &larr; {workspace.name}
        </Link>

        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">Skills</h1>
            <p className="text-text-muted mt-1">
              {skills.length} skill{skills.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="https://docs.buildd.dev/docs/features/skills"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-lg text-sm"
            >
              Docs
            </a>
            <SkillInstall workspaceId={id} />
            {!showNew && (
              <Link
                href={`/app/workspaces/${id}/skills?new=1`}
                className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-lg"
              >
                + Register Skill
              </Link>
            )}
          </div>
        </div>

        {showNew && (
          <div className="mb-8">
            <SkillForm workspaceId={id} />
          </div>
        )}

        <SkillList workspaceId={id} initialSkills={JSON.parse(JSON.stringify(skills))} />
      </div>
    </main>
  );
}
