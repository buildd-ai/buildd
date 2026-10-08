import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectorCatalogEntries } from '@buildd/core/db/schema';
import { isNull } from 'drizzle-orm';
import { authorizePlatformAdmin } from '@/lib/platform-admin';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { parseCatalogEntryInput, verifyCatalogServer, type CatalogEntryInput } from '@/lib/connector-catalog-input';

/**
 * Platform catalog (every team sees these). Platform admin API key only.
 * GET lists the built-ins and the platform rows that extend/override them.
 * POST adds an entry; a slug equal to a built-in overrides that built-in.
 */
export async function GET(req: NextRequest) {
  const auth = await authorizePlatformAdmin(req);
  if (auth.response) return auth.response;
  const rows = await db.query.connectorCatalogEntries.findMany({ where: isNull(connectorCatalogEntries.teamId) });
  return NextResponse.json({ builtins: CONNECTOR_CATALOG, entries: rows });
}

export async function POST(req: NextRequest) {
  const auth = await authorizePlatformAdmin(req);
  if (auth.response) return auth.response;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = parseCatalogEntryInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, message: parsed.message }, { status: 400 });
  const input = parsed.value as CatalogEntryInput;

  const verified = await verifyCatalogServer(input);
  if (!verified.ok) return NextResponse.json({ error: verified.error, message: verified.message }, { status: 422 });

  const [entry] = await db.insert(connectorCatalogEntries).values({
    ...input,
    authMode: verified.authMode,
    iconUrl: verified.iconUrl,
    teamId: null,
    createdByAccountId: auth.account.id,
  }).onConflictDoNothing().returning();
  if (!entry) return NextResponse.json({ error: 'slug_taken', message: `A platform entry "${input.slug}" already exists; PATCH it instead.` }, { status: 409 });
  return NextResponse.json({ entry }, { status: 201 });
}
