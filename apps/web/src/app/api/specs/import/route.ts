import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { importRepoSpecs, type ImportInput } from '@/lib/specs/import';

/**
 * POST /api/specs/import { workspaceId, dryRun? = true, ref?, paths?, allowDuplicates? }:
 * import the workspace repo's docs/specs/*.md as native specs (living-specs.md
 * §18, R-18; lib/specs/import.ts). Read at one commit through the GitHub App
 * (`ref`, default the default branch head). A dry run writes nothing and says,
 * per file, the spec it would create, its area, its provenance, its duplicates
 * and why a file is skipped. `dryRun: false` creates each spec with revision 1
 * imported, not approved; running it again with no repo change imports nothing.
 * Agents may import; confirming is a person's act (POST ./confirm).
 */
export async function POST(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await importRepoSpecs(caller, body as ImportInput);
  return r.ok ? NextResponse.json(r.result) : NextResponse.json({ error: r.error }, { status: r.status });
}
