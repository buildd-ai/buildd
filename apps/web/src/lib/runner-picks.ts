/**
 * Runner keys and the workspaces a person picked for them (spec "One runner
 * for every team you run"). The pure rules are in runner-picks-plan.ts; the
 * live re-check every claim applies is in granted-links.ts.
 *
 * Only a signed-in person reaches anything here: every caller is a session
 * route (the runner consent page, the picks endpoint, Settings). An API key or
 * an agent run has no path to write a pick (R-8).
 */
import { randomBytes } from 'crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { accounts, accountWorkspaces, teamMembers, teams, users, workspaces } from '@buildd/core/db/schema';
import { extractApiKeyPrefix, hashApiKey, invalidateAccountCacheByHash } from './api-auth';
import { invalidateAccountWorkspaceCache } from './account-workspace-cache';
import { consentTeamsForUser } from './mcp-grant-admin';
import { getUserDefaultTeamId } from './team-access';
import type { ApiKeyLevel } from './key-level-policy';
import type { ConsentTeam } from './oauth/account-consent';
import {
  checkPicks,
  chooseHomeTeam,
  levelForPicks,
  mayPickRestricted,
  runnerPickerTeams,
  teamsOfPicks,
} from './runner-picks-plan';

/**
 * What the edit page offers for one key: the consent page's teams, less the
 * workspaces a team admin removed this key from (they stay off until an admin
 * adds them back), and the names of those removed.
 */
export async function editConsentTeams(userId: string, accountId: string): Promise<{ teams: ConsentTeam[]; removedNames: string[] }> {
  const [offered, removedRows] = await Promise.all([
    runnerConsentTeams(userId),
    db
      .select({ workspaceId: accountWorkspaces.workspaceId, name: workspaces.name })
      .from(accountWorkspaces)
      .innerJoin(workspaces, eq(workspaces.id, accountWorkspaces.workspaceId))
      .where(and(eq(accountWorkspaces.accountId, accountId), isNotNull(accountWorkspaces.removedByUserId))),
  ]);
  const removed = new Set(removedRows.map((r) => r.workspaceId));
  const teams = offered
    .map((t) => ({ ...t, workspaces: t.workspaces.filter((w) => !removed.has(w.id)) }))
    .filter((t) => t.workspaces.length > 0);
  return { teams, removedNames: removedRows.map((r) => r.name) };
}

/** What the runner consent page offers this person now. */
export async function runnerConsentTeams(userId: string): Promise<ConsentTeam[]> {
  return runnerPickerTeams(await consentTeamsForUser(userId));
}

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

function pickRows(accountId: string, userId: string, workspaceIds: string[]) {
  return workspaceIds.map((workspaceId) => ({
    accountId,
    workspaceId,
    canClaim: true,
    canCreate: true,
    grantedByUserId: userId,
  }));
}

export type MintResult =
  | { ok: true; plaintextKey: string; accountId: string; level: ApiKeyLevel; teamId: string; workspaceIds: string[] }
  | { ok: false; status: 400 | 403 | 500; message: string };

/**
 * Mint a runner key for the picked workspaces (R-1..R-3). The picks are
 * checked against what the page offers now; the key's home team is the
 * person's default team when it holds a pick, else the first picked team; its
 * level is capped by the person's role in every picked team. The key is
 * confined to the picks (`workspace_ids`), and each pick is a granted row the
 * claim path re-checks live.
 */
export async function mintRunnerKey(args: {
  userId: string;
  workspaceIds: unknown;
  name: string;
  requestedLevel: ApiKeyLevel;
}): Promise<MintResult> {
  const offered = await runnerConsentTeams(args.userId);
  const check = checkPicks(offered, args.workspaceIds);
  if (!check.ok) return check;
  const home = chooseHomeTeam(offered, check.workspaceIds, await getUserDefaultTeamId(args.userId));
  if (!home) return { ok: false, status: 400, message: 'Choose at least one workspace.' };
  const level = levelForPicks(args.requestedLevel, teamsOfPicks(offered, check.workspaceIds));

  const plaintextKey = generateApiKey();
  const [created] = await db.insert(accounts).values({
    name: args.name,
    type: 'user',
    level,
    authType: 'api',
    apiKey: hashApiKey(plaintextKey),
    apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
    teamId: home.id,
    workspaceIds: check.workspaceIds,
    createdByUserId: args.userId,
  }).returning({ id: accounts.id });
  if (!created?.id) return { ok: false, status: 500, message: 'Could not create the key.' };

  try {
    await db.insert(accountWorkspaces).values(pickRows(created.id, args.userId, check.workspaceIds)).onConflictDoNothing();
  } catch (err) {
    // No transaction on neon-http: a key without its picks reaches nothing
    // useful, so take it back rather than hand it out.
    await db.delete(accounts).where(eq(accounts.id, created.id)).catch(() => {});
    throw err;
  }
  invalidateAccountWorkspaceCache(created.id);
  return { ok: true, plaintextKey, accountId: created.id, level, teamId: home.id, workspaceIds: check.workspaceIds };
}

export type ReplaceResult =
  | { ok: true; workspaceIds: string[] }
  | { ok: false; status: 400 | 403 | 404; message: string };

/**
 * Replace an existing key's picks without minting a new key (R-4). Only the
 * person who minted the key may; another person's key reads as not found.
 * A pick in a team where the person's role would cap the key below its level
 * is refused: widening a key never raises what it may do anywhere.
 */
export async function replaceRunnerPicks(args: {
  accountId: string;
  userId: string;
  workspaceIds: unknown;
}): Promise<ReplaceResult> {
  const account = await db.query.accounts.findFirst({
    where: sqlWhere(and(eq(accounts.id, args.accountId), eq(accounts.createdByUserId, args.userId))),
    columns: { id: true, apiKey: true, level: true },
  });
  if (!account) return { ok: false, status: 404, message: 'Key not found.' };

  const offered = await runnerConsentTeams(args.userId);
  const check = checkPicks(offered, args.workspaceIds);
  if (!check.ok) return check;
  const level = account.level as ApiKeyLevel;
  const capped = levelForPicks(level, teamsOfPicks(offered, check.workspaceIds));
  if (capped !== level) {
    return {
      ok: false,
      status: 403,
      message: `This key is ${level} level, and one of the chosen teams allows you up to ${capped}. Run buildd login to make a key for it.`,
    };
  }

  const existing = await db
    .select({
      workspaceId: accountWorkspaces.workspaceId,
      grantedByUserId: accountWorkspaces.grantedByUserId,
      removedByUserId: accountWorkspaces.removedByUserId,
    })
    .from(accountWorkspaces)
    .where(eq(accountWorkspaces.accountId, account.id));
  // A team admin removed this runner from a workspace: the owner cannot put it
  // back here (the row is a tombstone, see /api/workspaces/[id]/accounts).
  const removed = new Set(existing.filter((r) => r.removedByUserId).map((r) => r.workspaceId));
  if (check.workspaceIds.some((id) => removed.has(id))) {
    return { ok: false, status: 403, message: 'A team admin removed this runner from one of the chosen workspaces. Ask them to add it back.' };
  }
  // Ordinary (admin-made) links stay exactly as they are, and stay reachable:
  // an edit replaces only the person's own picks.
  const unmarked = existing.filter((r) => !r.grantedByUserId).map((r) => r.workspaceId);

  await db.delete(accountWorkspaces).where(and(
    eq(accountWorkspaces.accountId, account.id),
    isNotNull(accountWorkspaces.grantedByUserId),
    isNull(accountWorkspaces.removedByUserId),
    notInArray(accountWorkspaces.workspaceId, check.workspaceIds),
  ));
  await db.insert(accountWorkspaces).values(pickRows(account.id, args.userId, check.workspaceIds)).onConflictDoNothing();
  await db.update(accounts)
    .set({ workspaceIds: [...new Set([...check.workspaceIds, ...unmarked])] })
    .where(eq(accounts.id, account.id));

  invalidateAccountCacheByHash(account.apiKey);
  invalidateAccountWorkspaceCache(account.id);
  return { ok: true, workspaceIds: check.workspaceIds };
}

export interface RunnerKeyPick {
  workspaceId: string;
  workspaceName: string;
  teamId: string;
  teamName: string;
  /** The person can still reach it: member of its team, at a role it needs, not removed. */
  reachable: boolean;
  /** A team admin removed this runner from the workspace; Edit cannot put it back. */
  removedByAdmin: boolean;
}

export interface RunnerKeySummary {
  id: string;
  name: string;
  apiKeyPrefix: string | null;
  level: string;
  homeTeamName: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  /** Null = a key minted before picks: it reaches what its team reaches. */
  picks: RunnerKeyPick[] | null;
}

/** Every key this person minted, with its picks and whether each still reaches (R-4, AC-3). */
export async function listRunnerKeys(userId: string): Promise<RunnerKeySummary[]> {
  const keys = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      apiKeyPrefix: accounts.apiKeyPrefix,
      level: accounts.level,
      workspaceIds: accounts.workspaceIds,
      createdAt: accounts.createdAt,
      lastUsedAt: accounts.lastUsedAt,
      homeTeamName: teams.name,
    })
    .from(accounts)
    .innerJoin(teams, eq(teams.id, accounts.teamId))
    .where(and(eq(accounts.createdByUserId, userId), eq(accounts.type, 'user')))
    .orderBy(desc(accounts.createdAt), asc(accounts.id));
  if (keys.length === 0) return [];

  const pickedIds = [...new Set(keys.flatMap((k) => k.workspaceIds ?? []))];
  const [wsRows, memberships, removedRows] = await Promise.all([
    pickedIds.length > 0
      ? db
          .select({ id: workspaces.id, name: workspaces.name, teamId: workspaces.teamId, accessMode: workspaces.accessMode, teamName: teams.name })
          .from(workspaces)
          .innerJoin(teams, eq(teams.id, workspaces.teamId))
          .where(inArray(workspaces.id, pickedIds))
      : Promise.resolve([]),
    db.select({ teamId: teamMembers.teamId, role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.userId, userId)),
    db
      .select({ accountId: accountWorkspaces.accountId, workspaceId: accountWorkspaces.workspaceId })
      .from(accountWorkspaces)
      .where(and(inArray(accountWorkspaces.accountId, keys.map((k) => k.id)), isNotNull(accountWorkspaces.removedByUserId))),
  ]);
  const removed = new Set(removedRows.map((r) => `${r.accountId}:${r.workspaceId}`));
  const wsById = new Map(wsRows.map((w) => [w.id, w]));
  const roleByTeam = new Map(memberships.map((m) => [m.teamId, m.role as string]));

  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    apiKeyPrefix: k.apiKeyPrefix ?? null,
    level: k.level,
    homeTeamName: k.homeTeamName,
    createdAt: k.createdAt ? new Date(k.createdAt).toISOString() : null,
    lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : null,
    picks: k.workspaceIds == null ? null : k.workspaceIds.flatMap((id) => {
      const w = wsById.get(id);
      if (!w) return [];
      const role = roleByTeam.get(w.teamId);
      const removedByAdmin = removed.has(`${k.id}:${id}`);
      const reachable = !removedByAdmin && role != null && (w.accessMode === 'open' || mayPickRestricted(role));
      return [{ workspaceId: w.id, workspaceName: w.name, teamId: w.teamId, teamName: w.teamName, reachable, removedByAdmin }];
    }),
  }));
}

export interface ForeignRunner {
  accountId: string;
  accountName: string;
  ownerName: string;
  homeTeamName: string;
  workspaceId: string;
  workspaceName: string;
  teamName: string;
}

/**
 * Runners from other teams that reach a workspace of a team this person owns
 * or administers, through a person's pick, with the owner named (R-4). Their
 * admins remove one with DELETE /api/workspaces/[id]/accounts?accountId=.
 */
export async function listForeignRunners(userId: string): Promise<ForeignRunner[]> {
  const adminTeams = (await db
    .select({ teamId: teamMembers.teamId, role: teamMembers.role })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId)))
    .filter((m) => mayPickRestricted(m.role as string))
    .map((m) => m.teamId);
  if (adminTeams.length === 0) return [];

  const rows = await db
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      accountTeamId: accounts.teamId,
      ownerName: users.name,
      ownerEmail: users.email,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      teamName: teams.name,
    })
    .from(accountWorkspaces)
    .innerJoin(accounts, eq(accounts.id, accountWorkspaces.accountId))
    .innerJoin(workspaces, eq(workspaces.id, accountWorkspaces.workspaceId))
    .innerJoin(teams, eq(teams.id, workspaces.teamId))
    .innerJoin(users, eq(users.id, accountWorkspaces.grantedByUserId))
    .where(and(
      inArray(workspaces.teamId, adminTeams),
      isNotNull(accountWorkspaces.grantedByUserId),
      isNull(accountWorkspaces.removedByUserId),
      ne(accounts.teamId, workspaces.teamId),
    ))
    .orderBy(asc(teams.name), asc(workspaces.name), asc(accounts.name));
  if (rows.length === 0) return [];

  const homeIds = [...new Set(rows.map((r) => r.accountTeamId))];
  const homes = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, homeIds));
  const homeName = new Map(homes.map((t) => [t.id, t.name]));
  return rows.map((r) => ({
    accountId: r.accountId,
    accountName: r.accountName,
    ownerName: r.ownerName || r.ownerEmail,
    homeTeamName: homeName.get(r.accountTeamId) ?? '',
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName,
    teamName: r.teamName,
  }));
}
