/**
 * Who may call the relay routes (docs/specs/local-runner-provider.md §2.3, §4):
 * a runner's own `bld_` key, never a trigger token, naming a `runnerId` that is
 * a heartbeat row of the calling account. The runner learns that id from the
 * heartbeat response and echoes it on every relay call; an id of another
 * account (so of another team) is 403 and nothing is read or written.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { authenticateApiKey } from '@/lib/api-auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export type RelayCaller =
  | { ok: true; accountId: string; teamId: string; runnerId: string; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

const refuse = (error: string, status: number): RelayCaller => ({ ok: false, response: NextResponse.json({ error }, { status }) });

/** Authenticate the key, parse the JSON body and verify `body.runnerId` is the caller's own runner. */
export async function authenticateRelayRunner(req: NextRequest): Promise<RelayCaller> {
  const account = await authenticateApiKey(req.headers.get('authorization')?.replace('Bearer ', '') || null, req);
  if (!account) return refuse('Invalid API key', 401);
  if (account.level === 'trigger') return refuse('Trigger tokens cannot serve relay jobs', 403);

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed;
  } catch {
    return refuse('Invalid JSON body', 400);
  }
  if (!isUuid(body.runnerId)) return refuse('runnerId (the heartbeatId from the heartbeat response) is required', 400);

  const row = await db.query.workerHeartbeats.findFirst({
    where: sqlWhere(and(eq(workerHeartbeats.id, body.runnerId), eq(workerHeartbeats.accountId, account.id))),
    columns: { id: true },
  });
  if (!row) return refuse('runnerId is not a runner of this account', 403);
  return { ok: true, accountId: account.id, teamId: account.teamId, runnerId: body.runnerId.toLowerCase(), body };
}
