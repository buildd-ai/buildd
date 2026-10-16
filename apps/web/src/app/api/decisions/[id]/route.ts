/**
 * GET /api/decisions/[id] — MCP get_decision.
 *
 * One decision with what an auditor needs to judge it
 * (lib/decision-audit-bundle.ts): the question, the answers on offer, the
 * rule's answer, the model's answer, the answer in effect, and the subject's
 * later evidence. Platform owner, or a team admin for their own team
 * (lib/decision-audit-access.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { decisionRecords } from '@buildd/core/db/schema';
import { isUuid } from '@/lib/uuid';
import { authenticateDecisionAuditCaller, decisionNotFound, refuseDecisionAudit } from '@/lib/decision-audit-access';
import { loadDecisionAuditBundle } from '@/lib/decision-audit-bundle';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await authenticateDecisionAuditCaller(req);
  if ('response' in caller) return caller.response;
  if (!isUuid(id)) return decisionNotFound();

  const [record] = await db.select().from(decisionRecords).where(eq(decisionRecords.id, id)).limit(1);
  if (!record) return decisionNotFound();
  const refused = await refuseDecisionAudit(req, caller, record.teamId);
  if (refused) return refused;

  return NextResponse.json(await loadDecisionAuditBundle(record));
}
