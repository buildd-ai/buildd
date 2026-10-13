import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { batchFilings, organizeWorkspace, type OrganizeInput } from '@/lib/specs/organize';

/**
 * POST /api/specs/organize { workspaceId, dryRun? = true, limit?, areas?, edits? }:
 * organize a workspace's specs into its product > area > feature tree
 * (Living Specs §17, lib/specs/organize.ts).
 *
 * - No product and no area: `mode: taxonomy`. A dry run returns the proposed
 *   product and areas, each with a key, a charter and the specs it would hold;
 *   nothing exists until a person sends `dryRun: false` (optionally `areas`,
 *   the keys to accept, and `edits`, `{ [key]: { title?, charter? } }`).
 * - Otherwise `mode: sweep`: every unfiled spec not yet placed or reviewed,
 *   at most `limit` (default 50), as one batch grouped by area. A dry run
 *   writes nothing; `dryRun: false` applies confident filings (with undo) and
 *   records the rest as suggestions. Running it again finds nothing new.
 */
export async function POST(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await organizeWorkspace(caller, body as OrganizeInput);
  return r.ok ? NextResponse.json(r.result) : NextResponse.json({ error: r.error }, { status: r.status });
}

/** GET /api/specs/organize?workspaceId=&batchId=: the filings and suggestions one organize run made. */
export async function GET(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await batchFilings(caller, req.nextUrl.searchParams.get('workspaceId') ?? '', req.nextUrl.searchParams.get('batchId') ?? '');
  return r.ok ? NextResponse.json({ filings: r.filings }) : NextResponse.json({ error: r.error }, { status: r.status });
}
