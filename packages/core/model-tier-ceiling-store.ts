/**
 * Reads and writes model-tier ceilings (`teams.model_tier_ceilings`,
 * `team_members.model_tier_ceilings`). The rule is in @buildd/shared
 * (model-tier-ceiling.ts); the contract is docs/specs/model-tier-ceilings.md.
 *
 * No cross-request cache, on purpose. A ceiling is a spend control: a lowered
 * cap must hold on the very next claim or chat turn, on every server instance,
 * not after a TTL on whichever instance took the write. The reads are two
 * primary-key lookups; the claim route memoizes them within one request.
 *
 * Reads throw on a DB error rather than failing open. Callers hold the work
 * (claim: defer; chat: error) instead of guessing that no ceiling applies.
 *
 * Writes are read-modify-write under an optimistic lock on the JSON value
 * (neon-http has no interactive transactions), so two admins saving at once
 * cannot silently drop each other's change.
 *
 * Authorization is the caller's job (team admin for team/workspace/admin
 * layers, the member themselves for `self`); this module enforces tenancy:
 * a workspace cap is only accepted for a workspace of the same team, and a
 * member layer only for an existing member row of that team.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { teamMembers, teams, workspaces } from './db/schema';
import {
  appendCeilingAudit,
  isEmptyCeilings,
  resolveTierCeiling,
  type CeilingInputs,
  type CeilingSurface,
  type MemberTierCeilings,
  type SurfaceCeilings,
  type TeamTierCeilingPolicy,
  type TierCeiling,
} from '@buildd/shared';

export interface CeilingSubject {
  teamId: string | null | undefined;
  workspaceId?: string | null;
  /**
   * The person the run is for; null/undefined = unidentified automation. A
   * function is called only when the team has member layers at all
   * (`membersCapped`), so a claim does not resolve a requester for nothing.
   */
  userId?: string | null | (() => Promise<string | null>);
}

export async function loadTierCeilingInputs(subject: CeilingSubject): Promise<CeilingInputs> {
  const workspaceId = subject.workspaceId ?? null;
  if (!subject.teamId) return { team: null, workspaceId, userId: null, member: null };
  const teamRow = await db.query.teams.findFirst({ where: eq(teams.id, subject.teamId), columns: { modelTierCeilings: true } });
  const team = teamRow?.modelTierCeilings ?? null;
  const userId = team?.membersCapped
    ? (typeof subject.userId === 'function' ? await subject.userId() : subject.userId ?? null)
    : null;
  const member = userId
    ? await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, subject.teamId), eq(teamMembers.userId, userId)),
      columns: { modelTierCeilings: true },
    })
    : null;
  // A person who is not a member of this team is not identified FOR this
  // team: their caps elsewhere do not apply, and they get the team/workspace
  // layers like any other caller. With no member layers anywhere in the team
  // the person is irrelevant, so `identified` reports whether one was known.
  const known = typeof subject.userId === 'string' && subject.userId.length > 0;
  return {
    team,
    workspaceId,
    userId: member ? userId : team?.membersCapped ? null : known ? (subject.userId as string) : null,
    member: member?.modelTierCeilings ?? null,
  };
}

export async function loadTierCeiling(subject: CeilingSubject, surface: CeilingSurface): Promise<TierCeiling> {
  return resolveTierCeiling(await loadTierCeilingInputs(subject), surface);
}

/** Memoizes loadTierCeilingInputs within one request (the claim loop). */
export function tierCeilingLoader() {
  const teamMemo = new Map<string, Promise<CeilingInputs>>();
  return async (subject: CeilingSubject, surface: CeilingSurface): Promise<TierCeiling> => {
    // Memoized per team+workspace when the team has no member layers (the
    // requester cannot matter), else per resolved requester too.
    const base = `${subject.teamId ?? ''}|${subject.workspaceId ?? ''}`;
    let p = teamMemo.get(base);
    if (!p) { p = loadTierCeilingInputs({ ...subject, userId: null }); teamMemo.set(base, p); }
    const teamOnly = await p;
    if (!teamOnly.team?.membersCapped) return resolveTierCeiling(teamOnly, surface);
    const userId = typeof subject.userId === 'function' ? await subject.userId() : subject.userId ?? null;
    const key = `${base}|${userId ?? ''}`;
    let q = teamMemo.get(key);
    if (!q) { q = loadTierCeilingInputs({ ...subject, userId }); teamMemo.set(key, q); }
    return resolveTierCeiling(await q, surface);
  };
}

export class CeilingWriteError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}

const MAX_ATTEMPTS = 3;

function clean(c: SurfaceCeilings | undefined): SurfaceCeilings | undefined {
  return isEmptyCeilings(c) ? undefined : c;
}

/**
 * Update the team layer, workspace layers and/or overCapAuto. A key absent
 * from `patch` is left as is; `team: {}` or `workspaces[id]: {}` clears it.
 */
export async function writeTeamTierCeilings(args: {
  teamId: string;
  actorUserId: string;
  patch: { team?: SurfaceCeilings; workspaces?: Record<string, SurfaceCeilings>; overCapAuto?: 'downgrade' | 'deny' };
}): Promise<TeamTierCeilingPolicy> {
  const wsIds = Object.keys(args.patch.workspaces ?? {});
  if (wsIds.length > 0) {
    const owned = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.teamId, args.teamId));
    const set = new Set(owned.map((w) => w.id));
    const foreign = wsIds.find((id) => !set.has(id));
    if (foreign) throw new CeilingWriteError(`workspace ${foreign} is not in this team`, 400);
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await db.query.teams.findFirst({ where: eq(teams.id, args.teamId), columns: { modelTierCeilings: true } });
    if (!row) throw new CeilingWriteError('team not found', 404);
    const before = row.modelTierCeilings ?? null;
    const next: TeamTierCeilingPolicy = { ...(before ?? {}) };
    const at = new Date().toISOString();
    if (args.patch.team !== undefined) {
      next.audit = appendCeilingAudit(next.audit, { at, by: args.actorUserId, layer: 'team', before: before?.team ?? null, after: clean(args.patch.team) ?? null });
      next.team = clean(args.patch.team);
    }
    if (args.patch.workspaces) {
      const ws = { ...(next.workspaces ?? {}) };
      for (const [id, caps] of Object.entries(args.patch.workspaces)) {
        next.audit = appendCeilingAudit(next.audit, { at, by: args.actorUserId, layer: `workspace:${id}`, before: ws[id] ?? null, after: clean(caps) ?? null });
        if (clean(caps)) ws[id] = caps; else delete ws[id];
      }
      next.workspaces = Object.keys(ws).length ? ws : undefined;
    }
    if (args.patch.overCapAuto !== undefined) {
      next.audit = appendCeilingAudit(next.audit, { at, by: args.actorUserId, layer: 'over_cap_auto', before: before?.overCapAuto ?? null, after: args.patch.overCapAuto });
      next.overCapAuto = args.patch.overCapAuto;
    }
    const stored = JSON.parse(JSON.stringify(next)) as TeamTierCeilingPolicy;
    const updated = await db.update(teams)
      .set({ modelTierCeilings: stored })
      .where(and(eq(teams.id, args.teamId), sql`${teams.modelTierCeilings} IS NOT DISTINCT FROM ${before === null ? null : JSON.stringify(before)}::jsonb`))
      .returning({ id: teams.id });
    if (updated.length > 0) return stored;
  }
  throw new CeilingWriteError('ceilings changed while saving; reload and try again', 409);
}

/** Set one member layer. `caps: {}` clears it. */
export async function writeMemberTierCeilings(args: {
  teamId: string;
  userId: string;
  layer: 'admin' | 'self';
  caps: SurfaceCeilings;
  actorUserId: string;
}): Promise<MemberTierCeilings> {
  // Flag the team first: between the two writes a claim then over-reads (looks
  // up a member row that has no cap yet), never under-reads.
  if (!isEmptyCeilings(args.caps)) await markMembersCapped(args.teamId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, args.teamId), eq(teamMembers.userId, args.userId)),
      columns: { modelTierCeilings: true },
    });
    if (!row) throw new CeilingWriteError('not a member of this team', 404);
    const before = row.modelTierCeilings ?? null;
    const next: MemberTierCeilings = { ...(before ?? {}) };
    next.audit = appendCeilingAudit(next.audit, {
      at: new Date().toISOString(), by: args.actorUserId, layer: `member_${args.layer}`,
      before: before?.[args.layer] ?? null, after: clean(args.caps) ?? null,
    });
    next[args.layer] = clean(args.caps);
    const stored = JSON.parse(JSON.stringify(next)) as MemberTierCeilings;
    const updated = await db.update(teamMembers)
      .set({ modelTierCeilings: stored })
      .where(and(
        eq(teamMembers.teamId, args.teamId),
        eq(teamMembers.userId, args.userId),
        sql`${teamMembers.modelTierCeilings} IS NOT DISTINCT FROM ${before === null ? null : JSON.stringify(before)}::jsonb`,
      ))
      .returning({ userId: teamMembers.userId });
    if (updated.length > 0) return stored;
  }
  throw new CeilingWriteError('ceilings changed while saving; reload and try again', 409);
}

async function markMembersCapped(teamId: string): Promise<void> {
  await db.update(teams)
    .set({ modelTierCeilings: sql`jsonb_set(coalesce(${teams.modelTierCeilings}, '{}'::jsonb), '{membersCapped}', 'true'::jsonb)` })
    .where(eq(teams.id, teamId));
}

/** Every member's ceilings for the admin view, keyed by user id. */
export async function listMemberTierCeilings(teamId: string): Promise<Record<string, MemberTierCeilings>> {
  const rows = await db.select({ userId: teamMembers.userId, c: teamMembers.modelTierCeilings })
    .from(teamMembers).where(eq(teamMembers.teamId, teamId));
  return Object.fromEntries(rows.filter((r) => r.c).map((r) => [r.userId, r.c!]));
}
