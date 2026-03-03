import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskRecipes } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';

/**
 * Authenticate via session or API key.
 * For API keys, requires admin-level account (recipes are admin-only).
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

// GET /api/workspaces/[id]/recipes - List recipes for a workspace
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const recipes = await db.query.taskRecipes.findMany({
    where: eq(taskRecipes.workspaceId, id),
    orderBy: (r, { desc }) => [desc(r.createdAt)],
  });

  return NextResponse.json({ recipes });
}

// POST /api/workspaces/[id]/recipes - Create a new recipe
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authResult = await resolveAuth(req, id);
  if (!authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, description, category, steps, variables, isPublic } = body;

    if (!name || !steps || !Array.isArray(steps)) {
      return NextResponse.json(
        { error: 'name and steps (array) are required' },
        { status: 400 }
      );
    }

    if (steps.length === 0) {
      return NextResponse.json(
        { error: 'steps must have at least 1 entry' },
        { status: 400 }
      );
    }

    // Validate each step has ref + title, and refs are unique
    const refs = new Set<string>();
    for (const step of steps) {
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

    // Validate dependsOn refs point to valid step refs
    for (const step of steps) {
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

    const [recipe] = await db
      .insert(taskRecipes)
      .values({
        workspaceId: id,
        name,
        description: description || null,
        category: category || null,
        steps,
        variables: variables || {},
        isPublic: isPublic ?? false,
        createdByUserId: authResult.userId || null,
      })
      .returning();

    return NextResponse.json({ recipe }, { status: 201 });
  } catch (error) {
    console.error('Create recipe error:', error);
    return NextResponse.json({ error: 'Failed to create recipe' }, { status: 500 });
  }
}
