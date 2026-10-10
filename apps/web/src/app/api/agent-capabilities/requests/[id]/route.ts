/**
 * POST /api/agent-capabilities/requests/[id]
 *   Body: { decision: 'approve' | 'deny' | 'revoke', ttlSeconds?, reason? }
 *
 * A signed-in person with manage_connectors in the request's team approves
 * or denies a pending request, or revokes a grant. Never an API key: an agent
 * cannot approve its own request (lib/capability-grants-auth.ts). Idempotent:
 * repeating a decision answers 200 with `alreadyDecided: true`; a conflicting
 * one (deny after approve) answers 409 with the row as it stands. Approval can
 * only narrow the requested TTL and is refused past a forbidding policy, a
 * catalog block, a workspace disable, an ended task or worker, or a role change.
 * Revoking takes effect on the agent's next call: every use re-reads the grant.
 */
import { NextRequest, NextResponse } from 'next/server';
import { decideCapabilityRequest, loadGrant, type Decision } from '@/lib/capability-grants-store';
import { MANAGE_FORBIDDEN, resolveCapabilityAdminCaller } from '@/lib/capability-grants-auth';
import { MAX_GRANT_TTL_SECONDS, MIN_GRANT_TTL_SECONDS } from '@/lib/capability-grants';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS: readonly Decision[] = ['approve', 'deny', 'revoke'];
const NOT_FOUND = () => NextResponse.json({ error: 'Request not found' }, { status: 404 });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NOT_FOUND();

  let body: { decision?: unknown; ttlSeconds?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const decision = body.decision as Decision;
  if (!DECISIONS.includes(decision)) return NextResponse.json({ error: `decision must be one of ${DECISIONS.join(', ')}` }, { status: 400 });
  let ttlSeconds: number | null = null;
  if (body.ttlSeconds !== undefined && body.ttlSeconds !== null) {
    if (typeof body.ttlSeconds !== 'number' || !Number.isInteger(body.ttlSeconds) || body.ttlSeconds < MIN_GRANT_TTL_SECONDS || body.ttlSeconds > MAX_GRANT_TTL_SECONDS) {
      return NextResponse.json({ error: `ttlSeconds must be an integer between ${MIN_GRANT_TTL_SECONDS} and ${MAX_GRANT_TTL_SECONDS}` }, { status: 400 });
    }
    ttlSeconds = body.ttlSeconds;
  }
  const reason = typeof body.reason === 'string' ? body.reason : null;

  const row = await loadGrant(id);
  if (!row) {
    // Unknown id: still 401/403 without a session, else 404.
    const caller = await resolveCapabilityAdminCaller(req);
    return caller instanceof NextResponse ? caller : NOT_FOUND();
  }
  // Resolve the caller against the row's own team; not a member = not found.
  const caller = await resolveCapabilityAdminCaller(req, row.teamId);
  if (caller instanceof NextResponse) return caller.status === 404 ? NOT_FOUND() : caller;
  if (!caller.canManage) return MANAGE_FORBIDDEN();

  const out = await decideCapabilityRequest(row, decision, { userId: caller.userId }, { ttlSeconds, reason });
  if (!out.ok) return NextResponse.json({ error: out.error, code: out.code, ...(out.grant ? { grant: out.grant } : {}) }, { status: out.status });
  return NextResponse.json({ grant: out.grant, alreadyDecided: out.alreadyDecided });
}
