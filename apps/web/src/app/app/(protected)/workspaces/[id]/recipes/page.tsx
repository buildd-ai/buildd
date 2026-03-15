import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { db } from '@buildd/core/db';
import { workspaces, taskRecipes } from '@buildd/core/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess } from '@/lib/team-access';
import { RecipeList } from './RecipeList';
import { RecipeForm } from './RecipeForm';
import { PageContent } from '@/components/PageContent';

export const dynamic = 'force-dynamic';

export default async function RecipesPage({
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

  const recipes = await db.query.taskRecipes.findMany({
    where: eq(taskRecipes.workspaceId, id),
    orderBy: [desc(taskRecipes.createdAt)],
  });

  return (
    <PageContent>
        <Link href={`/app/workspaces/${id}`} className="text-sm text-text-muted hover:text-text-secondary mb-2 block">
          &larr; {workspace.name}
        </Link>

        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">Recipes</h1>
            <p className="text-text-muted mt-1">
              {recipes.length} recipe{recipes.length !== 1 ? 's' : ''}
            </p>
          </div>
          {!showNew && (
            <Link
              href={`/app/workspaces/${id}/recipes?new=1`}
              className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-lg"
            >
              + New Recipe
            </Link>
          )}
        </div>

        {showNew && (
          <div className="mb-8">
            <RecipeForm workspaceId={id} />
          </div>
        )}

        <RecipeList workspaceId={id} initialRecipes={JSON.parse(JSON.stringify(recipes))} />
    </PageContent>
  );
}
