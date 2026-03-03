import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskRecipes } from '@buildd/core/db/schema';
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

// GET /api/workspaces/[id]/recipes/[recipeId] - Get a single recipe
export async function GET(req: NextRequest, { params }: RouteParams) {
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

  return NextResponse.json({ recipe });
}

// PATCH /api/workspaces/[id]/recipes/[recipeId] - Update a recipe
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id, recipeId } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const existing = await db.query.taskRecipes.findFirst({
    where: and(
      eq(taskRecipes.id, recipeId),
      eq(taskRecipes.workspaceId, id)
    ),
  });

  if (!existing) {
    return NextResponse.json({ error: 'Recipe not found' }, { status: 404 });
  }

  try {
    const body = await req.json();
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.category !== undefined) updates.category = body.category;
    if (body.isPublic !== undefined) updates.isPublic = body.isPublic;
    if (body.variables !== undefined) updates.variables = body.variables;

    if (body.steps !== undefined) {
      if (!Array.isArray(body.steps) || body.steps.length === 0) {
        return NextResponse.json(
          { error: 'steps must be a non-empty array' },
          { status: 400 }
        );
      }

      const refs = new Set<string>();
      for (const step of body.steps) {
        if (!step.ref || !step.title) {
          return NextResponse.json(
            { error: 'Each step must have ref and title' },
            { status: 400 }
          );
        }
        if (refs.has(step.ref)) {
          return NextResponse.json(
            { error: `Duplicate step ref: ${step.ref}` },
            { status: 400 }
          );
        }
        refs.add(step.ref);
      }

      for (const step of body.steps) {
        if (step.dependsOn && Array.isArray(step.dependsOn)) {
          for (const dep of step.dependsOn) {
            if (!refs.has(dep)) {
              return NextResponse.json(
                { error: `Step "${step.ref}" depends on unknown ref "${dep}"` },
                { status: 400 }
              );
            }
          }
        }
      }

      updates.steps = body.steps;
    }

    const [updated] = await db
      .update(taskRecipes)
      .set(updates)
      .where(eq(taskRecipes.id, recipeId))
      .returning();

    return NextResponse.json({ recipe: updated });
  } catch (error) {
    console.error('Update recipe error:', error);
    return NextResponse.json({ error: 'Failed to update recipe' }, { status: 500 });
  }
}

// DELETE /api/workspaces/[id]/recipes/[recipeId] - Delete a recipe
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id, recipeId } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [deleted] = await db
    .delete(taskRecipes)
    .where(and(
      eq(taskRecipes.id, recipeId),
      eq(taskRecipes.workspaceId, id)
    ))
    .returning();

  if (!deleted) {
    return NextResponse.json({ error: 'Recipe not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
