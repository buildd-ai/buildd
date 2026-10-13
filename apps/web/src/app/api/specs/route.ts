import { NextRequest, NextResponse, after } from 'next/server';
import { createSpecDraft, listSpecs } from '@/lib/specs/store';
import { specCaller } from '@/lib/specs/caller';
import { suggestParent } from '@/lib/specs/neighbours';
import { organizeNewSpec } from '@/lib/specs/organize';
import { author } from '@/lib/specs/store';

/** GET /api/specs?workspaceId=: the workspace's Living Specs. */
export async function GET(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await listSpecs(caller, req.nextUrl.searchParams.get('workspaceId') ?? '');
  return r.ok ? NextResponse.json({ specs: r.specs }) : NextResponse.json({ error: r.error }, { status: r.status });
}

/**
 * POST /api/specs { workspaceId, title, body, scope?, parentSpecId?, changeSummary?, design?, supersedes?, distinctBecause? }:
 * a new draft, revision 1. A clear duplicate of an approved spec is a 409 with `code: spec_duplicate`
 * and the `duplicates`, unless `supersedes` or `distinctBecause` overrides it (lib/spec-duplicate-decision.ts).
 * A spec with no parent is filed after the response (§17, lib/specs/organize.ts): never a delay or a failure here.
 */
export async function POST(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await createSpecDraft(caller, body);
  if (r.ok) {
    // Offered, never applied (R-18): where a spec with no parent most likely belongs.
    const suggestedParent = r.spec.parentSpecId ? null : await suggestParent(r.spec.workspaceId, r.spec.id, `${r.spec.title}\n\n${String((body as Record<string, unknown>).body ?? '')}`).catch(() => null);
    if (!r.spec.parentSpecId) {
      const by = author(caller).label;
      const ids = caller.kind === 'user' ? { userId: caller.userId } : { accountId: caller.account.id };
      const text = String((body as Record<string, unknown>).body ?? '');
      after(() => organizeNewSpec(r.spec.id, { by, ...ids, body: text }).then(() => undefined));
    }
    return NextResponse.json({ spec: r.spec, revision: r.revision, duplicateCheck: r.duplicateCheck, suggestedParent }, { status: 201 });
  }
  return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.duplicates ? { duplicates: r.duplicates } : {}) }, { status: r.status });
}
