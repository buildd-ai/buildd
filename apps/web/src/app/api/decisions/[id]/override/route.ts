/**
 * POST /api/decisions/[id]/override  { answer, reason? }
 *
 * Correct a recorded Jev decision after the fact
 * (`packages/core/decision-ledger.ts` `recordHumanOverride` — this is its
 * first caller). Most immediately, this is the task-page affordance for a
 * question_gate `decide`: the owner can override the option Jev picked on
 * the agent's behalf (docs/design/human-question-gate.md).
 *
 * Recording-only: it does not re-run or undo whatever already happened with
 * the original answer — "Override never promises reversal of an irreversible
 * operation." Act on the correction yourself (e.g. steer the agent through
 * `/instruct` or `/respond`) if the decided answer needs to change something
 * that already ran.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { decisionRecords } from '@buildd/core/db/schema';
import { recordHumanOverride } from '@buildd/core/decision-ledger';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';

const notFound = () => NextResponse.json({ error: 'Decision not found' }, { status: 404 });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = apiKey ? await authenticateApiKey(apiKey, req) : null;
  if (!user && !account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 }); }
  const { answer, reason } = (body ?? {}) as { answer?: unknown; reason?: unknown };
  if (typeof answer !== 'string' || !answer.trim()) {
    return NextResponse.json({ error: 'answer is required: the corrected answer' }, { status: 400 });
  }

  const [record] = await db.select().from(decisionRecords).where(eq(decisionRecords.id, id)).limit(1);
  if (!record) return notFound();

  const teamIds = await resolveAccountTeamIds(user, account);
  if (!teamIds.includes(record.teamId)) return notFound();

  const overriddenBy = user?.id ?? account!.id;
  const override = {
    answer: answer.trim(),
    ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
  };
  await recordHumanOverride(record.id, override, overriddenBy);

  return NextResponse.json({ ok: true, decisionId: record.id, override });
}
