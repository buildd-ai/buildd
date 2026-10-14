import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { importRepoSpecs, type ImportInput } from '@/lib/specs/import';

/**
 * POST /api/specs/import { workspaceId, dryRun? = true, ref?, paths?, allowDuplicates?, limit? = 15, cursor?, attachProvenance?, attachTo? }:
 * import the workspace repo's docs/specs/*.md as native specs (living-specs.md
 * §18, R-18; lib/specs/import.ts). Read at one commit through the GitHub App
 * (`ref`, default the default branch head). A dry run writes nothing and says,
 * per file, the spec it would create, its area, its provenance, its duplicates
 * and why a file is skipped. `dryRun: false` creates each spec with revision 1
 * imported, not approved; running it again with no repo change imports nothing.
 * It pages: `limit` files (max 40) in path order, and `nextCursor` /
 * `remaining` in the reply; a cursor reads the same commit as its first page.
 * Each new spec is placed by the area classifier (a confident answer files
 * it, else it stays Unfiled with the suggestion), the declared-domain mapping
 * only when the classifier does not run. A page stops starting files after
 * its time budget and returns `nextCursor`, so it never times out.
 * A file already in buildd (recorded provenance, or the exact title) comes
 * back `exists` with that spec's link; `attachProvenance` on a real run
 * records the path and commit on it. A spec that only cites the path is a
 * `related` hint; `attachTo: { path: specId }` names it explicitly.
 * Agents may import; confirming is a person's act (POST ./confirm).
 */
/** A page's budget (lib/specs/import.ts IMPORT_PAGE_BUDGET_MS) plus the files in flight, with headroom. */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await importRepoSpecs(caller, body as ImportInput);
  return r.ok ? NextResponse.json(r.result) : NextResponse.json({ error: r.error }, { status: r.status });
}
