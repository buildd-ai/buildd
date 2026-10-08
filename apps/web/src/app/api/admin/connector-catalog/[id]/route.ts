import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectorCatalogEntries } from '@buildd/core/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { authorizePlatformAdmin } from '@/lib/platform-admin';
import { parseCatalogEntryInput, verifyCatalogServer } from '@/lib/connector-catalog-input';

const notFound = () => NextResponse.json({ error: 'Catalog entry not found' }, { status: 404 });

/** PATCH a platform entry; `enabled: false` withdraws it (and the built-in it overrides) for everyone. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const auth = await authorizePlatformAdmin(req);
  if (auth.response) return auth.response;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = parseCatalogEntryInput(body, true);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, message: parsed.message }, { status: 400 });
  const patch: Record<string, unknown> = { ...parsed.value };
  delete patch.slug;
  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled === 'boolean') patch.enabled = enabled;

  const where = and(eq(connectorCatalogEntries.id, id), isNull(connectorCatalogEntries.teamId));
  const current = await db.query.connectorCatalogEntries.findFirst({ where });
  if (!current) return notFound();
  if (patch.url || patch.authMode) {
    const verified = await verifyCatalogServer({
      url: (patch.url as string) ?? current.url,
      authMode: (patch.authMode as 'oauth' | 'none' | 'header') ?? (current.authMode as 'oauth' | 'none' | 'header'),
      iconUrl: (patch.iconUrl as string | null | undefined) ?? (patch.url ? null : current.iconUrl),
    });
    if (!verified.ok) return NextResponse.json({ error: verified.error, message: verified.message }, { status: 422 });
    patch.authMode = verified.authMode;
    patch.iconUrl = verified.iconUrl;
  }
  const [entry] = await db.update(connectorCatalogEntries).set({ ...patch, updatedAt: new Date() }).where(where).returning();
  if (!entry) return notFound();
  return NextResponse.json({ entry });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const auth = await authorizePlatformAdmin(req);
  if (auth.response) return auth.response;
  const [deleted] = await db.delete(connectorCatalogEntries)
    .where(and(eq(connectorCatalogEntries.id, id), isNull(connectorCatalogEntries.teamId)))
    .returning({ id: connectorCatalogEntries.id });
  if (!deleted) return notFound();
  return NextResponse.json({ success: true });
}
