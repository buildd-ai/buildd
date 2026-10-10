/**
 * /api/quality-scout/runs/[id]/evidence — a runner-hosted Scout run's
 * evidence objects (command logs). Design: artifact quality-scout-runner-host §4.
 *
 * POST (the runner holding the run's lease): { leaseId, kind, seq, sizeBytes }
 *   → a presigned PUT for one object on the workspace's resolved evidence
 *   backend (ScoutRunEvidenceUploadResponse). Runner key auth, the same lease
 *   check as [id]/probes; a non-holder gets no URL (404 another team's run,
 *   409 a lease it does not hold). The runner PUTs exactly `sizeBytes` bytes,
 *   confirms at [id]/evidence/[evidenceId]/confirm, then cites the object in
 *   a probe result as `evidence:<evidenceId>`. See lib/quality-scout-run-evidence.ts.
 *
 * GET (a reader: dashboard session or API key with access to the run's
 * workspace): lists the run's objects, or with `evidenceId` (+ tail / grep /
 * range / cursor) returns redacted text, at most 64 KB. The read_evidence
 * MCP action reads a Scout run's object through here. Never a presigned URL.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { EvidenceKind, ScoutRunEvidenceListResponse, ScoutRunEvidenceReadResponse } from '@buildd/shared';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';
import { getCurrentUser } from '@/lib/auth-helpers';
import { EVIDENCE_UPLOAD_EXPIRY_SECONDS, generateEvidenceUploadUrl, resolveEvidenceBackend } from '@/lib/evidence-backend';
import {
  EVIDENCE_KINDS, EvidenceReadError, auditEvidenceRead, findScoutRunEvidenceObject, listScoutRunEvidenceObjects,
  openEvidenceObject, parseEvidenceReadParams, readEvidenceText, toEvidenceObjectSummary,
} from '@/lib/evidence-read';
import { requestScoutRunEvidenceUpload } from '@/lib/quality-scout-run-evidence';
import { dbScoutRunEvidenceStore, loadScoutRunScope } from '@/lib/quality-scout-run-evidence-store';
import { dbScoutRunnerHostStore } from '@/lib/quality-scout-runner-host-store';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { fail, NO_STORE, resolveScoutHostCaller } from '../../caller';

const LIST_LIMIT = 200;
const MAX_BODY_BYTES = 4 * 1024;
const READ_QUERY_KEYS = ['tail', 'grep', 'range', 'cursor'] as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return fail(404, 'Scout run not found', 'run_not_found');

  const auth = await resolveScoutHostCaller(req);
  if (!auth.ok) return auth.response;

  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return fail(413, `Body over ${MAX_BODY_BYTES} bytes`, 'payload_too_large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Body must be an object');

  const out = await requestScoutRunEvidenceUpload(
    { caller: auth.caller, runId: id, body: body as Record<string, unknown>, now: new Date() },
    {
      hostStore: dbScoutRunnerHostStore,
      evidenceStore: dbScoutRunEvidenceStore,
      resolveBackend: resolveEvidenceBackend,
      signUpload: generateEvidenceUploadUrl,
      expiresInSeconds: EVIDENCE_UPLOAD_EXPIRY_SECONDS,
    },
  );
  return NextResponse.json(out.body, { status: out.status, headers: NO_STORE });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Scout run not found' }, { status: 404 });

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  // A per-task token reads evidence only in its own task's workspace.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const canAccess = async (workspaceId: string): Promise<boolean> =>
    apiAccount
      ? tokenWorkspaceAllowed(apiAccount.workspaceIds, workspaceId) && taskScopeAllowsWorkspace(apiAccount, workspaceId)
        && verifyAccountWorkspaceAccess(apiAccount, workspaceId)
      : !!(await verifyWorkspaceAccess(user!.id, workspaceId));

  const run = await loadScoutRunScope(id);
  // A run in a workspace the caller cannot reach reads exactly like no run.
  if (!run || !(await canAccess(run.workspaceId))) return NextResponse.json({ error: 'Scout run not found' }, { status: 404 });

  const sp = req.nextUrl.searchParams;
  const kind = sp.get('kind');
  if (kind && !EVIDENCE_KINDS.includes(kind as EvidenceKind)) {
    return NextResponse.json({ error: `kind must be one of: ${EVIDENCE_KINDS.join(', ')}` }, { status: 400 });
  }
  const actor = apiAccount ? { accountId: apiAccount.id } : { userId: user!.id };

  const evidenceId = sp.get('evidenceId');
  if (!evidenceId) {
    const rows = await listScoutRunEvidenceObjects(run, { limit: LIST_LIMIT, ...(kind ? { kind: kind as EvidenceKind } : {}) });
    const objects = rows.map(toEvidenceObjectSummary);
    auditEvidenceRead({
      surface: 'GET /api/quality-scout/runs/:id/evidence', op: 'list', workspaceId: run.workspaceId, scoutRunId: run.id,
      evidenceIds: objects.map(o => o.id), actor, ...(kind ? { query: { kind } } : {}),
    });
    const body: ScoutRunEvidenceListResponse = { scoutRunId: run.id, workspaceId: run.workspaceId, objects };
    return NextResponse.json(body);
  }

  if (!isUuid(evidenceId)) return NextResponse.json({ error: 'evidenceId must be a full UUID' }, { status: 400 });
  const parsed = parseEvidenceReadParams(sp);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const row = await findScoutRunEvidenceObject(run, evidenceId);
  if (!row) return NextResponse.json({ error: 'Evidence object not found for this Scout run' }, { status: 404 });

  let result;
  try {
    result = await readEvidenceText(await openEvidenceObject(row), parsed.options);
  } catch (err) {
    if (err instanceof EvidenceReadError) return NextResponse.json({ error: err.message, evidenceId }, { status: err.status });
    console.error('[evidence-read] decode failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'this evidence object could not be decoded (corrupt or not text)', evidenceId }, { status: 422 });
  }

  const query: Record<string, string> = {};
  for (const k of READ_QUERY_KEYS) {
    const v = sp.get(k);
    if (v) query[k] = v;
  }
  auditEvidenceRead({
    surface: 'GET /api/quality-scout/runs/:id/evidence', op: 'read', workspaceId: run.workspaceId, scoutRunId: run.id,
    evidenceIds: [row.id], actor, query, bytesReturned: Buffer.byteLength(result.text), truncated: result.truncated,
  });

  const body: ScoutRunEvidenceReadResponse = {
    ...result,
    scoutRunId: run.id,
    workspaceId: run.workspaceId,
    object: toEvidenceObjectSummary(row),
  };
  return NextResponse.json(body);
}
