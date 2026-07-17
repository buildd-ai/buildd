// POST /api/connectors/[id]/assertion
//
// Mints a short-lived (5-minute) assertion JWT for a worker to present at a
// resource server's token endpoint (assertion grant, RFC 7523).
//
// Auth: Bearer <account API key> (the same key the runner uses for claim/PATCH).
// Rate limit: 12 mint requests per worker per connector per minute.
// Spec: docs/design/cross-app-assertion-grant.md §C

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, tasks, connectors, connectorWorkspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getActiveSigningKey, signAssertion } from '@/lib/signing-keys';
import { Redis } from '@upstash/redis';

// ---------------------------------------------------------------------------
// Rate limiting via Redis (degrades to allow if Redis unavailable)
// ---------------------------------------------------------------------------
let redis: Redis | null = null;
try {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
} catch {}

const RATE_LIMIT = 12; // per worker per connector per minute

async function checkRateLimit(workerId: string, connectorId: string): Promise<boolean> {
  if (!redis) return true; // fail open if Redis unavailable
  const key = `buildd:mint:${workerId}:${connectorId}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    return count <= RATE_LIMIT;
  } catch {
    return true; // fail open on Redis error
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: connectorId } = await params;

  // ── Auth ─────────────────────────────────────────────────────────────────
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') ?? null;
  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { workerId?: string; taskId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request', error_description: 'Invalid JSON' }, { status: 400 });
  }

  const { workerId, taskId } = body;
  if (!workerId || !taskId) {
    return NextResponse.json({ error: 'invalid_request', error_description: 'workerId and taskId are required' }, { status: 400 });
  }

  // ── Validate worker belongs to this account and task ─────────────────────
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    columns: { id: true, accountId: true, taskId: true, workspaceId: true, status: true },
  });

  if (!worker || worker.accountId !== account.id) {
    return NextResponse.json({ error: 'Unauthorized', error_description: 'Worker not found or does not belong to this account' }, { status: 401 });
  }

  // Worker must be active (not completed/errored/cancelled)
  if (worker.status === 'completed' || worker.status === 'error' || worker.status === 'cancelled') {
    return NextResponse.json({ error: 'Unauthorized', error_description: 'Worker token has been revoked' }, { status: 401 });
  }

  // taskId must match the worker's active task
  if (worker.taskId !== taskId) {
    return NextResponse.json({ error: 'Forbidden', error_description: 'taskId does not match worker active task' }, { status: 403 });
  }

  // ── Load task to get accountId and workspaceId ────────────────────────────
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, workspaceId: true },
  });

  if (!task) {
    return NextResponse.json({ error: 'Forbidden', error_description: 'Task not found' }, { status: 403 });
  }

  // ── Load connector ────────────────────────────────────────────────────────
  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.id, connectorId),
    columns: {
      id: true,
      teamId: true,
      authMode: true,
      assertionAudience: true,
      assertionTokenEndpoint: true,
    },
  });

  if (!connector) {
    return NextResponse.json({ error: 'not_found', error_description: 'Connector not found' }, { status: 404 });
  }

  if (connector.authMode !== 'assertion') {
    return NextResponse.json({ error: 'Forbidden', error_description: 'Connector does not use assertion auth mode' }, { status: 403 });
  }

  // ── Verify connector enabled for this workspace ──────────────────────────
  // Consistent with the claim route: a missing row is treated as enabled
  // (explicitly disabled = cwRow.enabled === false).
  const cwRow = await db.query.connectorWorkspaces.findFirst({
    where: and(
      eq(connectorWorkspaces.connectorId, connectorId),
      eq(connectorWorkspaces.workspaceId, task.workspaceId),
    ),
    columns: { enabled: true },
  });

  if (cwRow !== undefined && !cwRow.enabled) {
    return NextResponse.json({ error: 'Forbidden', error_description: 'Connector not enabled for this workspace' }, { status: 403 });
  }

  // ── Validate connector configuration ─────────────────────────────────────
  if (!connector.assertionAudience || !connector.assertionTokenEndpoint) {
    console.error(`[AssertionMint] Connector ${connectorId} missing assertionAudience or assertionTokenEndpoint`);
    return NextResponse.json({ error: 'internal_error', error_description: 'Connector misconfigured (operator error)' }, { status: 500 });
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  const allowed = await checkRateLimit(workerId, connectorId);
  if (!allowed) {
    return NextResponse.json({ error: 'rate_limit_exceeded', error_description: 'Too many assertion requests' }, { status: 429 });
  }

  // ── Get Active signing key ────────────────────────────────────────────────
  const activeKey = await getActiveSigningKey();
  if (!activeKey) {
    console.error('[AssertionMint] No active signing key found');
    return NextResponse.json({ error: 'internal_error', error_description: 'No active signing key' }, { status: 500 });
  }

  // ── Build assertion claims per spec §A.1 ─────────────────────────────────
  const iatSec = Math.floor(Date.now() / 1000);
  const expSec = iatSec + 300; // 5 minutes

  // sub = accountId:teamId (tenant identity)
  const sub = `${account.id}:${account.teamId}`;

  // jti: 128-bit random hex
  const jtiBytes = crypto.getRandomValues(new Uint8Array(16));
  const jti = Array.from(jtiBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  const payload = {
    iss: 'https://buildd.dev',
    sub,
    act: {
      sub: `worker:${workerId}`,
      tid: taskId,
    },
    aud: connector.assertionAudience,
    jti,
    iat: iatSec,
    exp: expSec,
  };

  const assertion = await signAssertion(payload, activeKey.privateKeyJwk, activeKey.kid);

  const expiresAt = new Date(expSec * 1000).toISOString();

  return NextResponse.json({
    assertion,
    audience: connector.assertionAudience,
    tokenEndpoint: connector.assertionTokenEndpoint,
    expiresAt,
  });
}
