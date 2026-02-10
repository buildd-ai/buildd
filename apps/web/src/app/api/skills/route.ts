import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { skills } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';

// Resolve the owner (user) ID from either session or API key auth
async function resolveOwnerId(req: NextRequest): Promise<string | null> {
  // Try session auth first
  const user = await getCurrentUser();
  if (user) return user.id;

  // Fall back to API key → account → ownerId
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (account?.ownerId) return account.ownerId;

  return null;
}

// GET /api/skills — list skills for the authenticated owner
export async function GET(req: NextRequest) {
  const ownerId = await resolveOwnerId(req);
  if (!ownerId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const results = await db.query.skills.findMany({
      where: eq(skills.ownerId, ownerId),
      orderBy: (s, { asc }) => [asc(s.slug)],
    });

    return NextResponse.json({ skills: results });
  } catch (error) {
    console.error('List skills error:', error);
    return NextResponse.json({ error: 'Failed to list skills' }, { status: 500 });
  }
}

// POST /api/skills — register a skill (upserts by slug)
export async function POST(req: NextRequest) {
  const ownerId = await resolveOwnerId(req);
  if (!ownerId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { slug, name, description, contentHash, source, sourceVersion } = body;

    if (!slug || !name || !contentHash) {
      return NextResponse.json(
        { error: 'slug, name, and contentHash are required' },
        { status: 400 }
      );
    }

    // Validate slug format (lowercase, alphanumeric, hyphens)
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      return NextResponse.json(
        { error: 'slug must be lowercase alphanumeric with hyphens (e.g., "ui-audit")' },
        { status: 400 }
      );
    }

    // Upsert: update if slug already exists for this owner
    const existing = await db.query.skills.findFirst({
      where: and(eq(skills.ownerId, ownerId), eq(skills.slug, slug)),
    });

    if (existing) {
      const [updated] = await db
        .update(skills)
        .set({
          name,
          description: description || null,
          contentHash,
          source: source || null,
          sourceVersion: sourceVersion || null,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, existing.id))
        .returning();

      return NextResponse.json({ skill: updated });
    }

    const [skill] = await db
      .insert(skills)
      .values({
        ownerId,
        slug,
        name,
        description: description || null,
        contentHash,
        source: source || null,
        sourceVersion: sourceVersion || null,
      })
      .returning();

    return NextResponse.json({ skill }, { status: 201 });
  } catch (error) {
    console.error('Register skill error:', error);
    return NextResponse.json({ error: 'Failed to register skill' }, { status: 500 });
  }
}
