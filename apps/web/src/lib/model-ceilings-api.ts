/**
 * The model-tier ceilings API (docs/specs/model-tier-ceilings.md):
 *
 *   GET  /api/teams/[id]/model-ceilings[?workspaceId=]   any member, or a key of the team
 *   PUT  /api/teams/[id]/model-ceilings                  manage_model_tiers: team / workspace caps, overCapAuto
 *   PUT  /api/teams/[id]/model-ceilings/members/[userId] manage_model_tiers: that member's admin cap
 *   PUT  /api/teams/[id]/model-ceilings/me               the signed-in member: their own cap
 *
 * Write rights: the team and workspace layers and a member's admin layer are
 * the team's (owner/admin by default, through the `manage_model_tiers`
 * permission, which a team can re-grant). The `self` layer is the person's
 * own and only they can write it — not an admin, not a key. A member cannot
 * touch the admin layer, so they cannot lift what an admin set.
 *
 * Handlers take their dependencies so they are tested without a DB; the
 * route files bind the real ones.
 */
import {
  explainTierCeiling,
  parseSurfaceCeilings,
  resolveTierCeiling,
  type CeilingSurface,
  type MemberTierCeilings,
  type SurfaceCeilings,
  type TeamTierCeilingPolicy,
  type TierCeiling,
} from '@buildd/shared';
import type { TeamScopeCaller } from './permission-registry';

export interface CeilingsApiDeps {
  /** The caller, or null when unauthenticated. */
  caller(): Promise<TeamScopeCaller | null>;
  isMember(userId: string, teamId: string): Promise<boolean>;
  canManage(caller: TeamScopeCaller, teamId: string): Promise<boolean>;
  loadPolicy(teamId: string): Promise<TeamTierCeilingPolicy | null>;
  loadMember(teamId: string, userId: string): Promise<MemberTierCeilings | null>;
  listMembers(teamId: string): Promise<Record<string, MemberTierCeilings>>;
  writeTeam(args: { teamId: string; actorUserId: string; patch: { team?: SurfaceCeilings; workspaces?: Record<string, SurfaceCeilings>; overCapAuto?: 'downgrade' | 'deny' } }): Promise<TeamTierCeilingPolicy>;
  writeMember(args: { teamId: string; userId: string; layer: 'admin' | 'self'; caps: SurfaceCeilings; actorUserId: string }): Promise<MemberTierCeilings>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function actorOf(c: TeamScopeCaller): string {
  return c.kind === 'user' ? c.userId : `account:${c.accountId}`;
}

function writeError(err: unknown): Response {
  const status = (err as { status?: number })?.status;
  if (status === 400 || status === 404 || status === 409) return json({ error: (err as Error).message }, status);
  throw err;
}

/** The policy without its audit tail and internal flag, for a non-admin reader. */
function publicPolicy(p: TeamTierCeilingPolicy | null) {
  return { team: p?.team ?? {}, workspaces: p?.workspaces ?? {}, overCapAuto: p?.overCapAuto ?? 'downgrade' };
}

function effective(c: TierCeiling) {
  return { max: c.max, binding: c.binding, layers: c.layers, identified: c.identified, overCapAuto: c.overCapAuto, explanation: explainTierCeiling(c) };
}

async function teamCaller(deps: CeilingsApiDeps, teamId: string): Promise<{ response: Response } | { caller: TeamScopeCaller }> {
  const caller = await deps.caller();
  if (!caller) return { response: json({ error: 'Unauthorized' }, 401) };
  const inTeam = caller.kind === 'account' ? caller.teamId === teamId : await deps.isMember(caller.userId, teamId);
  if (!inTeam) return { response: json({ error: 'Team not found' }, 404) };
  return { caller };
}

export async function handleGetCeilings(teamId: string, workspaceId: string | null, deps: CeilingsApiDeps): Promise<Response> {
  const r = await teamCaller(deps, teamId);
  if ('response' in r) return r.response;
  const { caller } = r;
  const policy = await deps.loadPolicy(teamId);
  const userId = caller.kind === 'user' ? caller.userId : null;
  const member = userId ? await deps.loadMember(teamId, userId) : null;
  const inputs = { team: policy, workspaceId, userId, member };
  const manage = await deps.canManage(caller, teamId);
  const surfaces: CeilingSurface[] = ['agent', 'chat'];
  return json({
    policy: publicPolicy(policy),
    me: userId ? { admin: member?.admin ?? {}, self: member?.self ?? {} } : null,
    effective: Object.fromEntries(surfaces.map((s) => [s, effective(resolveTierCeiling(inputs, s))])),
    canManage: manage,
    ...(manage ? { members: await deps.listMembers(teamId), audit: policy?.audit ?? [] } : {}),
  });
}

export async function handlePutTeamCeilings(teamId: string, body: unknown, deps: CeilingsApiDeps): Promise<Response> {
  const r = await teamCaller(deps, teamId);
  if ('response' in r) return r.response;
  if (!(await deps.canManage(r.caller, teamId))) return json({ error: 'Only a team admin can change team or workspace tier maximums.' }, 403);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'body must be an object' }, 400);
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !['team', 'workspaces', 'overCapAuto'].includes(k));
  if (unknown.length) return json({ error: `unknown field(s): ${unknown.join(', ')}` }, 400);
  const patch: { team?: SurfaceCeilings; workspaces?: Record<string, SurfaceCeilings>; overCapAuto?: 'downgrade' | 'deny' } = {};
  if (b.team !== undefined) {
    const p = parseSurfaceCeilings(b.team);
    if (!p.ok) return json({ error: `team: ${p.error}` }, 400);
    patch.team = p.value;
  }
  if (b.workspaces !== undefined) {
    if (!b.workspaces || typeof b.workspaces !== 'object' || Array.isArray(b.workspaces)) return json({ error: 'workspaces must be an object keyed by workspace id' }, 400);
    patch.workspaces = {};
    for (const [id, caps] of Object.entries(b.workspaces as Record<string, unknown>)) {
      const p = parseSurfaceCeilings(caps);
      if (!p.ok) return json({ error: `workspaces.${id}: ${p.error}` }, 400);
      patch.workspaces[id] = p.value;
    }
  }
  if (b.overCapAuto !== undefined) {
    if (b.overCapAuto !== 'downgrade' && b.overCapAuto !== 'deny') return json({ error: "overCapAuto must be 'downgrade' or 'deny'" }, 400);
    patch.overCapAuto = b.overCapAuto;
  }
  try {
    const policy = await deps.writeTeam({ teamId, actorUserId: actorOf(r.caller), patch });
    return json({ policy: publicPolicy(policy) });
  } catch (err) { return writeError(err); }
}

function readCaps(body: unknown): { ok: true; value: SurfaceCeilings } | { ok: false; res: Response } {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).ceilings : undefined;
  if (raw === undefined) return { ok: false, res: json({ error: 'body must be { ceilings: { all?, agent?, chat? } } ({} clears)' }, 400) };
  const p = parseSurfaceCeilings(raw);
  return p.ok ? { ok: true, value: p.value } : { ok: false, res: json({ error: p.error }, 400) };
}

export async function handlePutMemberCeilings(teamId: string, userId: string, body: unknown, deps: CeilingsApiDeps): Promise<Response> {
  const r = await teamCaller(deps, teamId);
  if ('response' in r) return r.response;
  if (!(await deps.canManage(r.caller, teamId))) return json({ error: "Only a team admin can set a member's tier maximum." }, 403);
  const caps = readCaps(body);
  if (!caps.ok) return caps.res;
  try {
    const member = await deps.writeMember({ teamId, userId, layer: 'admin', caps: caps.value, actorUserId: actorOf(r.caller) });
    return json({ member: { admin: member.admin ?? {}, self: member.self ?? {} } });
  } catch (err) { return writeError(err); }
}

export async function handlePutOwnCeilings(teamId: string, body: unknown, deps: CeilingsApiDeps): Promise<Response> {
  const r = await teamCaller(deps, teamId);
  if ('response' in r) return r.response;
  if (r.caller.kind !== 'user') return json({ error: 'A personal tier maximum belongs to a person; sign in to set yours. An API key has none.' }, 403);
  const caps = readCaps(body);
  if (!caps.ok) return caps.res;
  try {
    const member = await deps.writeMember({ teamId, userId: r.caller.userId, layer: 'self', caps: caps.value, actorUserId: r.caller.userId });
    return json({ me: { admin: member.admin ?? {}, self: member.self ?? {} } });
  } catch (err) { return writeError(err); }
}
