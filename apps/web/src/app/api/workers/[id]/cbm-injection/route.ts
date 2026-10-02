/**
 * POST /api/workers/[id]/cbm-injection  { facts: CbmInjectionFacts }
 *
 * CBM search injection's decision (docs/design/cbm-search-injection.md, Flow 4).
 * The runner calls this only after its own deterministic diff found graph
 * locations the agent's search did not show, and asks which list to show:
 * `inject_callers`, `inject_impact` or `skip`.
 *
 * Server-side because the decision spends the TEAM's key, which never reaches
 * a runner. Facts only: the body is validated field by field
 * (`parseCbmInjectionFacts`) so no command, pattern, symbol name or path can
 * reach the model. Bounded at ~900ms; the runner aborts at 1s and injects
 * callers on any failure, so every error here is a 200 `{ ok: false }` with a
 * kind rather than a status the runner would have to interpret.
 *
 * Auth: the API key of the account that owns the worker.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import { parseCbmInjectionFacts } from '@buildd/core/cbm-injection';
import { authenticateApiKey } from '@/lib/api-auth';
import { isUuid } from '@/lib/uuid';
import { decideCbmInjection } from '@/lib/cbm-injection-decision';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const notFound = () => NextResponse.json({ error: 'Worker not found' }, { status: 404 });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateApiKey(apiKey);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return notFound();

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 }); }
  const parsed = parseCbmInjectionFacts((body as { facts?: unknown } | null)?.facts);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, accountId: true, workspaceId: true },
  });
  if (!worker || worker.accountId !== account.id) return notFound();

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, worker.workspaceId),
    columns: { id: true, teamId: true },
  });
  if (!workspace?.teamId) return notFound();

  const reply = await decideCbmInjection(
    { teamId: workspace.teamId, workspaceId: workspace.id, accountId: worker.accountId },
    parsed.facts,
  );
  return NextResponse.json(reply);
}
