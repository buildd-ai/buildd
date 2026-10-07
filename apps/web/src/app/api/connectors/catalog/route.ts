import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectorCatalogEntries } from '@buildd/core/db/schema';
import { loadTeamCatalog } from '@/lib/connector-catalog-store';
import { resolveConnectorTeam, forbidden } from '@/lib/connector-team-auth';
import { parseCatalogEntryInput, verifyCatalogServer, type CatalogEntryInput } from '@/lib/connector-catalog-input';

/**
 * GET — the catalog the caller's active team sees (built-in + platform + team
 * entries, each with the team's policy). Members never see blocked entries;
 * admins do, so they can unblock them.
 */
export async function GET(req: NextRequest) {
  const caller = await resolveConnectorTeam(req);
  if (caller instanceof NextResponse) return caller;
  try {
    const entries = await loadTeamCatalog(caller.teamId);
    return NextResponse.json({
      canManage: caller.canManage,
      entries: caller.canManage ? entries : entries.filter(e => e.policy !== 'blocked'),
    });
  } catch (error) {
    console.error('List connector catalog error:', error);
    return NextResponse.json({ error: 'Failed to load catalog' }, { status: 500 });
  }
}

/** POST — a team admin adds an entry private to their team (e.g. an internal MCP server). */
export async function POST(req: NextRequest) {
  const caller = await resolveConnectorTeam(req);
  if (caller instanceof NextResponse) return caller;
  if (!caller.canManage) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = parseCatalogEntryInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, message: parsed.message }, { status: 400 });
  const input = parsed.value as CatalogEntryInput;

  const verified = await verifyCatalogServer(input);
  if (!verified.ok) return NextResponse.json({ error: verified.error, message: verified.message }, { status: 422 });

  try {
    const [entry] = await db.insert(connectorCatalogEntries).values({
      ...input,
      authMode: verified.authMode,
      iconUrl: verified.iconUrl,
      teamId: caller.teamId,
      createdByAccountId: caller.accountId,
    }).onConflictDoNothing().returning();
    if (!entry) return NextResponse.json({ error: 'slug_taken', message: `Your team already has a catalog entry "${input.slug}".` }, { status: 409 });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    console.error('Create team catalog entry error:', error);
    return NextResponse.json({ error: 'Failed to create catalog entry' }, { status: 500 });
  }
}
