import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskRecipes, tasks } from '@buildd/core/db/schema';
import type { RecipeStep } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

type RouteParams = { params: Promise<{ id: string; recipeId: string }> };

/**
 * Authenticate via session or admin-level API key.
 */
async function resolveAuth(req: NextRequest, workspaceId: string) {
  const user = await getCurrentUser();
  if (user) {
    const access = await verifyWorkspaceAccess(user.id, workspaceId);
    if (access) return { userId: user.id };
  }

  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (account) {
    if (account.level !== 'admin') return null;
    const hasAccess = await verifyAccountWorkspaceAccess(account.id, workspaceId);
    if (hasAccess) return { accountId: account.id };
  }

  return null;
}

/**
 * Interpolate {{varName}} placeholders in a string with variable values.
 */
function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
}

// POST /api/workspaces/[id]/recipes/[recipeId]/run - Instantiate recipe into tasks
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, recipeId } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const recipe = await db.query.taskRecipes.findFirst({
    where: and(
      eq(taskRecipes.id, recipeId),
      eq(taskRecipes.workspaceId, id)
    ),
  });

  if (!recipe) {
    return NextResponse.json({ error: 'Recipe not found' }, { status: 404 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const variables: Record<string, string> = body.variables || {};
    const parentTaskId: string | undefined = body.parentTaskId;

    const steps = recipe.steps as RecipeStep[];

    // Two-pass approach: create all tasks first, then update dependsOn
    const refToId: Record<string, string> = {};
    const createdTaskIds: string[] = [];

    // First pass: create all tasks without dependsOn
    for (const step of steps) {
      const title = interpolate(step.title, variables);
      const description = step.description ? interpolate(step.description, variables) : null;

      const [created] = await db
        .insert(tasks)
        .values({
          workspaceId: id,
          title,
          description,
          parentTaskId: parentTaskId || null,
          mode: step.mode || 'execution',
          creationSource: 'api',
          status: 'pending',
          priority: step.priority ?? 0,
          requiredCapabilities: step.requiredCapabilities ?? [],
          outputRequirement: step.outputRequirement || undefined,
          dependsOn: [],
        })
        .returning();

      refToId[step.ref] = created.id;
      createdTaskIds.push(created.id);
    }

    // Second pass: update dependsOn with resolved task IDs
    for (const step of steps) {
      if (step.dependsOn && step.dependsOn.length > 0) {
        const resolvedDeps = step.dependsOn
          .map((ref) => refToId[ref])
          .filter(Boolean);

        if (resolvedDeps.length > 0) {
          await db
            .update(tasks)
            .set({ dependsOn: resolvedDeps, updatedAt: new Date() })
            .where(eq(tasks.id, refToId[step.ref]));
        }
      }
    }

    return NextResponse.json({ tasks: createdTaskIds }, { status: 201 });
  } catch (error) {
    console.error('Run recipe error:', error);
    return NextResponse.json({ error: 'Failed to run recipe' }, { status: 500 });
  }
}
