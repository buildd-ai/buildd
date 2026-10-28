/**
 * POST /api/agent-capabilities/database-query
 *
 * A running agent reads the team's production database through buildd, under
 * a live task-scoped `database.query` grant (asked for with request_capability
 * { provider: 'neon', access: 'read' }). buildd holds the connection: the
 * statement runs as a read-only role, in a READ ONLY transaction, with a
 * statement timeout and a row cap, over an allowlist of tables. The response
 * carries rows and never a credential.
 *
 *   Authorization: Bearer <per-task token (bldt_…) or runner API key>
 *   Body: { workerId, sql, params?, maxRows? }
 *
 * The principal is re-resolved on every request and a task token is confined
 * to its own task. Every outcome, refusals included, is one row on the task's
 * access trail with the SQL text, row count and duration; never the rows.
 *
 * Rules: lib/capability-database-query.ts. Spec: docs/specs/database-query-agent-capability.md
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller, taskScopeAllowsWorker, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { resolveWorkerPrincipal } from '@/lib/agent-capabilities/worker-principal';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import { DATABASE_QUERY_CAPABILITY, parseDatabaseQueryRequest, runDatabaseQuery } from '@/lib/capability-database-query';
import { defaultDatabaseQueryDeps } from '@/lib/capability-database-query-store';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 64 * 1024;

function fail(status: number, error: string, code?: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...(code ? { code } : {}), ...extra }, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return fail(401, 'Unauthorized');
  if (account.level === 'trigger') return fail(403, 'Trigger tokens cannot query the database');

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return fail(413, 'Body too large', 'invalid_request');
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return fail(400, 'Invalid body', 'invalid_request');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return fail(413, 'Body too large', 'invalid_request');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'Invalid JSON body', 'invalid_request');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Body must be an object', 'invalid_request');

  const { workerId, ...rest } = body;
  if (typeof workerId !== 'string' || !ID_RE.test(workerId)) return fail(400, 'workerId is required', 'invalid_request');

  const principalVia = account.taskScope ? 'task_token' as const : 'runner_key' as const;
  const resolved = await resolveWorkerPrincipal(account, { workerId });
  if (resolved.ok && !(taskScopeAllowsWorker(account, { taskId: resolved.principal.taskId })
    && taskScopeAllowsWorkspace(account, resolved.principal.workspaceId))) {
    void recordCapabilityDecision({ capability: DATABASE_QUERY_CAPABILITY, decision: 'refused', accountId: account.id, principalVia, resource: `worker:${workerId}`, reasonCode: 'task_scope_mismatch' });
    return fail(404, 'Worker not found');
  }
  if (!resolved.ok) {
    void recordCapabilityDecision({ capability: DATABASE_QUERY_CAPABILITY, decision: 'refused', accountId: account.id, principalVia, resource: `worker:${workerId}`, reasonCode: resolved.reasonCode });
    return fail(resolved.status, resolved.error, resolved.status === 409 ? resolved.reasonCode : undefined);
  }
  const principal = resolved.principal;
  const base = {
    capability: DATABASE_QUERY_CAPABILITY, workspaceId: principal.workspaceId, taskId: principal.taskId,
    workerId: principal.workerId, accountId: principal.accountId, principalVia,
  } as const;

  const parsed = parseDatabaseQueryRequest(rest);
  if (!parsed.ok) {
    void recordCapabilityDecision({ ...base, decision: 'refused', resource: `task:${principal.taskId}`, reasonCode: 'invalid_request' });
    return fail(400, parsed.error, 'invalid_request');
  }

  const deps = defaultDatabaseQueryDeps(row => {
    void recordCapabilityDecision({
      ...base,
      decision: row.decision,
      resource: row.grantId ? `grant:${row.grantId}` : `task:${principal.taskId}`,
      reasonCode: row.reasonCode,
      expiresAt: row.expiresAt,
      sideEffect: row.sideEffect,
    });
  });
  const out = await runDatabaseQuery(principal, parsed.request, deps);
  if (!out.ok) return fail(out.status, out.error, out.code, out.requestWith ? { requestWith: out.requestWith } : undefined);
  return NextResponse.json({
    rows: out.rows, fields: out.fields, rowCount: out.rowCount, truncated: out.truncated, durationMs: out.durationMs, grantId: out.grantId,
  }, { headers: NO_STORE });
}
