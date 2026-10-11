import { NextRequest, NextResponse } from 'next/server';
import { getSpec, reviseSpecDraft } from '@/lib/specs/store';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/** GET /api/specs/[specId][?revision=N]: the spec at its head or at revision N, exactly as written. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const raw = req.nextUrl.searchParams.get('revision');
  const revision = raw === null ? undefined : Number(raw);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) return NextResponse.json({ error: 'revision must be a positive integer' }, { status: 400 });
  const r = await getSpec(caller, specId, { revision });
  return r.ok ? NextResponse.json(r.view) : NextResponse.json({ error: r.error }, { status: r.status });
}

/**
 * PATCH /api/specs/[specId] { expectedVersion, body, changeSummary? }: revise the
 * draft. A stale expectedVersion is a 409 with currentVersion: re-read, merge,
 * revise on top. Agents and people may revise; approving is a separate,
 * person-only act.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await reviseSpecDraft(caller, specId, body);
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.currentVersion !== undefined ? { code: 'version_conflict', currentVersion: r.currentVersion } : {}) }, { status: r.status });
  return NextResponse.json({ spec: r.spec, revision: r.revision, unchanged: r.unchanged });
}
