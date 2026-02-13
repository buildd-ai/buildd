import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { skills, workspaces, accounts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    if (account) return { type: 'api' as const, account };
  }

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

// GET /api/workspaces/[id]/skills - List skills for a workspace
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const enabledOnly = url.searchParams.get('enabled') === 'true';

  const conditions = [eq(skills.workspaceId, id)];
  if (enabledOnly) {
    conditions.push(eq(skills.enabled, true));
  }

  const results = await db.query.skills.findMany({
    where: and(...conditions),
    orderBy: (s, { asc }) => [asc(s.name)],
  });

  return NextResponse.json({ skills: results });
}

// POST /api/workspaces/[id]/skills - Create a new skill
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify workspace exists (session users must own it)
  const wsConditions = [eq(workspaces.id, id)];
  if (auth.type === 'session') {
    wsConditions.push(eq(workspaces.ownerId, auth.user.id));
  }
  const workspace = await db.query.workspaces.findFirst({
    where: and(...wsConditions),
    columns: { id: true },
  });

  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    const body = await req.json();
    const { name, slug: requestedSlug, description, content, source, metadata, enabled } = body;

    if (!name || !content) {
      return NextResponse.json(
        { error: 'name and content are required' },
        { status: 400 }
      );
    }

    const slug = requestedSlug || generateSlug(name);

    // Check for duplicate slug in workspace
    const existing = await db.query.skills.findFirst({
      where: and(eq(skills.workspaceId, id), eq(skills.slug, slug)),
      columns: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: `Skill with slug "${slug}" already exists in this workspace` },
        { status: 409 }
      );
    }

    const [skill] = await db
      .insert(skills)
      .values({
        workspaceId: id,
        slug,
        name,
        description: description || null,
        content,
        source: source || 'manual',
        metadata: metadata || {},
        enabled: enabled !== false,
      })
      .returning();

    return NextResponse.json({ skill }, { status: 201 });
  } catch (error) {
    console.error('Create skill error:', error);
    return NextResponse.json({ error: 'Failed to create skill' }, { status: 500 });
  }
}
