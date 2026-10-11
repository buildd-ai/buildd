/**
 * /api/agent-capabilities/policy — the team's capability policy.
 *
 * GET    any team member: the team's rules plus the built-in defaults.
 * PUT    { provider, risk, effect, workspaceId?, roleSlug?, environment?, resource?, maxTtlSeconds? }
 *        upserts the one rule for that scope.
 * DELETE ?id=<rule id> removes a rule (the default applies again).
 *
 * Changing policy needs a signed-in person with manage_connectors in the team;
 * any API key, agent keys included, is refused (lib/capability-grants-auth.ts).
 * `auto_grant` is refused for write and admin. Tightening a rule takes effect
 * on the next call of every policy-granted grant it covers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { capabilityPolicies, workspaces } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { parsePolicyRule, policyScopeKey, MAX_GRANT_TTL_SECONDS } from '@/lib/capability-grants';
import { loadPolicyRules } from '@/lib/capability-grants-store';
import { MANAGE_FORBIDDEN, resolveCapabilityAdminCaller } from '@/lib/capability-grants-auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULTS = {
  read: 'auto_grant where a role in the workspace already mounts the connector; otherwise ask_human',
  query: 'auto_grant where a role in the workspace already mounts the connector; otherwise ask_human',
  write: 'ask_human (a rule cannot auto-grant writes)',
  admin: 'ask_human (a rule cannot auto-grant admin)',
  maxTtlSeconds: MAX_GRANT_TTL_SECONDS,
};

function teamParam(req: NextRequest): string | null | NextResponse {
  const t = req.nextUrl.searchParams.get('teamId');
  if (t && !UUID_RE.test(t)) return NextResponse.json({ error: 'invalid teamId' }, { status: 400 });
  return t;
}

export async function GET(req: NextRequest) {
  const t = teamParam(req);
  if (t instanceof NextResponse) return t;
  const caller = await resolveCapabilityAdminCaller(req, t);
  if (caller instanceof NextResponse) return caller;
  const rules = await loadPolicyRules(caller.teamId);
  return NextResponse.json({ teamId: caller.teamId, canManage: caller.canManage, rules, defaults: DEFAULTS });
}

export async function PUT(req: NextRequest) {
  const t = teamParam(req);
  if (t instanceof NextResponse) return t;
  const caller = await resolveCapabilityAdminCaller(req, t);
  if (caller instanceof NextResponse) return caller;
  if (!caller.canManage) return MANAGE_FORBIDDEN();

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = parsePolicyRule(body);
  if (!parsed.ok) return NextResponse.json({ error: 'invalid_rule', message: parsed.error }, { status: 400 });
  const rule = parsed.rule;

  // A workspace-scoped rule must name one of this team's workspaces.
  if (rule.workspaceId) {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, rule.workspaceId), columns: { teamId: true } });
    if (!ws || ws.teamId !== caller.teamId) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const scopeKey = policyScopeKey(rule);
  const values = {
    teamId: caller.teamId, provider: rule.provider, risk: rule.risk, workspaceId: rule.workspaceId, roleSlug: rule.roleSlug,
    environment: rule.environment, resource: rule.resource, effect: rule.effect, maxTtlSeconds: rule.maxTtlSeconds,
    scopeKey, updatedByUserId: caller.userId,
  };
  const [row] = await db.insert(capabilityPolicies).values(values)
    .onConflictDoUpdate({
      target: [capabilityPolicies.teamId, capabilityPolicies.scopeKey],
      set: { effect: rule.effect, maxTtlSeconds: rule.maxTtlSeconds, updatedByUserId: caller.userId, updatedAt: new Date() },
    })
    .returning();
  return NextResponse.json({ rule: { id: row.id, ...rule } });
}

export async function DELETE(req: NextRequest) {
  const t = teamParam(req);
  if (t instanceof NextResponse) return t;
  const caller = await resolveCapabilityAdminCaller(req, t);
  if (caller instanceof NextResponse) return caller;
  if (!caller.canManage) return MANAGE_FORBIDDEN();
  const id = req.nextUrl.searchParams.get('id');
  if (!id || !UUID_RE.test(id)) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  const deleted = await db.delete(capabilityPolicies)
    .where(and(eq(capabilityPolicies.id, id), eq(capabilityPolicies.teamId, caller.teamId)))
    .returning({ id: capabilityPolicies.id });
  if (deleted.length === 0) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  return NextResponse.json({ deleted: id });
}
