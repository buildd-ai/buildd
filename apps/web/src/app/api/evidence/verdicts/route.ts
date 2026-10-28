import { NextRequest, NextResponse } from 'next/server';
import { specCaller } from '@/lib/specs/caller';
import { reach } from '@/lib/specs/store';
import { criteriaForEvidence, evidenceForCriterion, type EvidenceKind } from '@/lib/specs/verdict-provenance';
import { isUuid } from '@/lib/uuid';

const KINDS: readonly EvidenceKind[] = ['test', 'task', 'pr', 'commit'];

/**
 * GET /api/evidence/verdicts?workspaceId=&specRevisionId=&criterionId=: the evidence behind a criterion (forward).
 * GET /api/evidence/verdicts?workspaceId=&kind=&ref=: the criteria a test, task, PR or commit speaks for (backward).
 * Both are scoped to the workspace's own specs.
 */
export async function GET(req: NextRequest) {
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const workspaceId = q.get('workspaceId') ?? '';
  const specRevisionId = q.get('specRevisionId');
  const criterionId = q.get('criterionId');
  const kind = q.get('kind');
  const ref = q.get('ref');

  const forward = !!(specRevisionId || criterionId);
  const backward = !!(kind || ref);
  if (forward === backward) return NextResponse.json({ error: 'give either specRevisionId and criterionId, or kind and ref' }, { status: 400 });
  if (forward && (!specRevisionId || !isUuid(specRevisionId) || !criterionId)) {
    return NextResponse.json({ error: 'specRevisionId (a uuid) and criterionId are required' }, { status: 400 });
  }
  if (backward && (!kind || !KINDS.includes(kind as EvidenceKind) || !ref)) {
    return NextResponse.json({ error: `kind (${KINDS.join(', ')}) and ref are required` }, { status: 400 });
  }
  if (!isUuid(workspaceId) || !(await reach(caller, workspaceId, false))) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  if (forward) return NextResponse.json({ evidence: await evidenceForCriterion(workspaceId, specRevisionId!, criterionId!) });
  return NextResponse.json({ criteria: await criteriaForEvidence(workspaceId, kind as EvidenceKind, ref!) });
}
