/**
 * POST /api/decisions/[id]/label  { label, rationale, ruleLabel? } — MCP label_decision.
 *
 * An auditor's grade of one decision (packages/core/decision-feature-health.ts
 * `labelDecisionAudit`): `label` ('right' | 'wrong' | 'unsure') grades the
 * model's answer, or the answer in effect when it gave none, under source
 * `agent_audit`; `ruleLabel` grades the rule's answer on the same decision
 * under `agent_audit_rule`, so the rule has a baseline. `rationale` is at most
 * 280 characters. The first grade per source stands: the same one again is a
 * duplicate, a different one comes back as a conflict naming the existing
 * label. Platform owner, or a team admin for their own team
 * (lib/decision-audit-access.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { decisionRecords } from '@buildd/core/db/schema';
import { AUDIT_LABELS, AUDIT_RATIONALE_MAX, isAuditLabel, labelDecisionAudit } from '@buildd/core/decision-feature-health';
import { isUuid } from '@/lib/uuid';
import { auditCallerOf, authenticateDecisionAuditCaller, decisionNotFound, refuseDecisionAudit } from '@/lib/decision-audit-access';

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await authenticateDecisionAuditCaller(req);
  if ('response' in caller) return caller.response;
  if (!isUuid(id)) return decisionNotFound();

  let body: unknown;
  try { body = await req.json(); } catch { return bad('Body must be JSON'); }
  const { label, rationale, ruleLabel } = (body ?? {}) as { label?: unknown; rationale?: unknown; ruleLabel?: unknown };
  if (!isAuditLabel(label)) return bad(`label must be one of ${AUDIT_LABELS.join(', ')}`);
  if (ruleLabel != null && !isAuditLabel(ruleLabel)) return bad(`ruleLabel must be one of ${AUDIT_LABELS.join(', ')}`);
  const why = typeof rationale === 'string' ? rationale.trim() : '';
  if (!why || why.length > AUDIT_RATIONALE_MAX) return bad(`rationale is required, at most ${AUDIT_RATIONALE_MAX} characters`);

  const [record] = await db.select().from(decisionRecords).where(eq(decisionRecords.id, id)).limit(1);
  if (!record) return decisionNotFound();
  const refused = await refuseDecisionAudit(req, caller, record.teamId);
  if (refused) return refused;

  const result = await labelDecisionAudit({
    record: {
      id: record.id, teamId: record.teamId, capability: record.capability, status: record.status,
      verdict: record.verdict, ruleAnswer: record.ruleAnswer, appliedAnswer: record.appliedAnswer,
    },
    label,
    rationale: why,
    ruleLabel: (ruleLabel as string | null | undefined) ?? null,
    by: auditCallerOf(caller),
  });
  if (!result.ok) {
    if (result.error === 'invalid') return bad(result.detail ?? 'invalid label');
    if (result.error === 'not_found') return decisionNotFound();
    return NextResponse.json({ error: 'The grade could not be stored. Nothing was written; try again.' }, { status: 503 });
  }
  return NextResponse.json({ ...result, decisionId: record.id });
}
