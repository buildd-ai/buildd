import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, secrets, type WorkspaceWorkTrackerConfig } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { decrypt } from '@buildd/core/secrets';
import {
  verifyLinearSignature,
  parseLinearIssueEvent,
  handleLinearIssueEvent,
  WEBHOOK_MAX_SKEW_MS,
} from '@/lib/linear-webhook';

/**
 * Inbound Linear webhook (work-tracker spec §3, Phase 3a).
 *
 * `POST /api/webhooks/linear/[workspaceId]` — a labeled Linear issue creates a
 * linked buildd task; a closed/removed issue cancels the linked task if open.
 *
 * The workspace is in the PATH (Linear's payload carries no buildd workspace id
 * and the §3 signing secret is per-workspace). The workspace id is not a secret;
 * the HMAC signing secret (stored in `secrets`, purpose='webhook_token',
 * label='linear') is what authenticates the delivery.
 */

type Db = typeof db;

async function defaultGetWorkspace(database: Db, id: string) {
  return database.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { teamId: true, workTrackerConfig: true },
  }) as Promise<{ teamId: string; workTrackerConfig: WorkspaceWorkTrackerConfig | null } | undefined>;
}

async function defaultGetSigningSecret(database: Db, workspaceId: string): Promise<string | null> {
  const row = await database.query.secrets.findFirst({
    where: and(
      eq(secrets.workspaceId, workspaceId),
      eq(secrets.purpose, 'webhook_token'),
      eq(secrets.label, 'linear'),
    ),
    columns: { encryptedValue: true },
  });
  if (!row?.encryptedValue) return null;
  try {
    return decrypt(row.encryptedValue);
  } catch {
    return null;
  }
}

/**
 * Pure, DI-testable core. Returns an HTTP status + JSON body. Dependencies
 * (workspace/secret readers, signature verifier, event handler, clock) are
 * injectable so the route logic is unit-testable without mocking shared modules.
 */
export async function processLinearWebhook(
  database: Db,
  input: { workspaceId: string; rawBody: string; signature: string | null },
  deps: {
    getWorkspace?: typeof defaultGetWorkspace;
    getSigningSecret?: typeof defaultGetSigningSecret;
    verify?: typeof verifyLinearSignature;
    handle?: typeof handleLinearIssueEvent;
    now?: () => number;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const getWorkspace = deps.getWorkspace ?? defaultGetWorkspace;
  const getSigningSecret = deps.getSigningSecret ?? defaultGetSigningSecret;
  const verify = deps.verify ?? verifyLinearSignature;
  const handle = deps.handle ?? handleLinearIssueEvent;
  const now = deps.now ?? Date.now;

  const ws = await getWorkspace(database, input.workspaceId);
  if (!ws) return { status: 404, body: { error: 'Unknown workspace' } };

  const secret = await getSigningSecret(database, input.workspaceId);
  if (!secret) return { status: 401, body: { error: 'Webhook not configured' } };

  if (!(await verify(input.rawBody, input.signature, secret))) {
    return { status: 401, body: { error: 'Invalid signature' } };
  }

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: 'Invalid JSON' } };
  }

  // Replay guard — reject a delivery whose timestamp has drifted too far.
  const ts = payload.webhookTimestamp;
  if (typeof ts === 'number' && Math.abs(now() - ts) > WEBHOOK_MAX_SKEW_MS) {
    return { status: 401, body: { error: 'Stale delivery' } };
  }

  // Only act for Linear-tracked workspaces; a well-formed but irrelevant delivery is a no-op.
  if (ws.workTrackerConfig?.provider !== 'linear') {
    return { status: 200, body: { ok: true, action: 'ignored', reason: 'provider' } };
  }

  const inboundLabel = ws.workTrackerConfig.inboundLabel || 'buildd';
  const event = parseLinearIssueEvent(payload, inboundLabel);
  const result = await handle(database, { workspaceId: input.workspaceId, teamId: ws.teamId }, event);
  return { status: 200, body: { ok: true, action: result.action, taskId: result.taskId } };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const rawBody = await req.text();
  const signature = req.headers.get('linear-signature');
  try {
    const { status, body } = await processLinearWebhook(db, { workspaceId, rawBody, signature });
    return NextResponse.json(body, { status });
  } catch (err) {
    console.error('[linear-webhook] processing error:', err);
    // 500 lets Linear retry a transient failure.
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
