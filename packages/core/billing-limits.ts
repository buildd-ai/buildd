// The plan limits, enforced: the knowledge-base document cap. The member/seat
// limit lives in ./billing.ts (`seatDecision`), also driven by entitlements.
// Every check reads `entitlements(team)` (./entitlements.ts) and nothing else,
// and every check is a no-op while BILLING_ENFORCED is off — it returns "allowed"
// before touching the database.
//
// Decision calls on buildd's key are the third limit; they live with the key
// resolver in ./decision-client.ts.
//
// What a limit never does: delete, hide or stop serving anything already
// stored. A team over its cap (it was over before enforcement, or it downgraded)
// keeps every document; only additions are refused.
//
// The DB client is imported lazily so the pure parts load in a plain bun script
// and route tests can inject their own deps.

import { entitlements, isBillingEnforced, type Entitlements, type EntitlementTeam } from './entitlements';

type Env = Record<string, string | undefined>;

/** Where every refusal points. The page is the billing settings section. */
export const BILLING_SETTINGS_HINT = 'Settings → Billing';

export const KNOWLEDGE_BASE_LIMIT_CODE = 'plan_knowledge_base_limit' as const;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Team entitlements ────────────────────────────────────────────────────────

/**
 * A team's entitlements, read from its row. While billing is off this returns
 * the unlimited entitlements without a DB read. A failed or missing read is
 * also unlimited: a lookup blip must never refuse a paying team.
 */
export async function loadTeamEntitlements(
  teamId: string,
  opts: { env?: Env; loadTeam?: (teamId: string) => Promise<EntitlementTeam | null> } = {},
): Promise<Entitlements> {
  const env = opts.env ?? process.env;
  if (!isBillingEnforced(env)) return entitlements({}, { env });
  try {
    const team = await (opts.loadTeam ?? loadTeamPlanRow)(teamId);
    if (!team) return entitlements({}, { env: {} });
    return entitlements(team, { env });
  } catch (e) {
    console.warn(`[billing] plan lookup failed for team ${teamId}:`, e);
    return entitlements({}, { env: {} });
  }
}

async function loadTeamPlanRow(teamId: string): Promise<EntitlementTeam | null> {
  const [{ db }, { teams }, { eq }] = await Promise.all([
    import('./db'), import('./db/schema'), import('drizzle-orm'),
  ]);
  const row = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    columns: { plan: true, paidSeats: true },
  });
  return row ?? null;
}

// ── Knowledge base ───────────────────────────────────────────────────────────

/**
 * The knowledge-base cap counts DOCUMENTS: distinct files in the `docs` corpus
 * across all of the team's workspaces (`FREE_KNOWLEDGE_BASE_DOC_CAP`). The code
 * index, memories and task history are not knowledge-base documents and are
 * never refused here.
 */
export interface DocsAdmission {
  /** Paths that may be written: everything already stored, plus new ones up to the cap. */
  admitted: string[];
  /** New paths turned away by the cap. Empty when nothing was refused. */
  refused: string[];
  cap: number | null;
  /** The plain refusal, or null when nothing was refused. */
  message: string | null;
}

export function knowledgeBaseLimitMessage(cap: number, refused: number): string {
  return `Your plan's knowledge base holds up to ${plural(cap, 'document', 'documents')}, so ` +
    `${plural(refused, 'new document was', 'new documents were')} not added. ` +
    `Everything already stored stays searchable. To add more, upgrade the plan in ${BILLING_SETTINGS_HINT}.`;
}

/**
 * Pure admission: a path already stored is an update and always goes through
 * (it doesn't grow the count); a new path goes through while there is room.
 */
export function planDocsAdmission(input: {
  cap: number | null;
  storedCount: number;
  alreadyStored: ReadonlySet<string>;
  paths: readonly string[];
}): DocsAdmission {
  if (input.cap === null) return { admitted: [...input.paths], refused: [], cap: null, message: null };
  let room = Math.max(0, input.cap - input.storedCount);
  const admitted: string[] = [];
  const refused: string[] = [];
  const seenNew = new Set<string>();
  for (const p of input.paths) {
    if (input.alreadyStored.has(p)) { admitted.push(p); continue; }
    if (seenNew.has(p)) { admitted.push(p); continue; }
    if (room > 0) { room--; seenNew.add(p); admitted.push(p); continue; }
    refused.push(p);
  }
  return {
    admitted,
    refused,
    cap: input.cap,
    message: refused.length > 0 ? knowledgeBaseLimitMessage(input.cap, refused.length) : null,
  };
}

export interface KnowledgeBaseCapDeps {
  /** The team that owns the workspace, with its plan columns. */
  loadWorkspaceTeam?: (workspaceId: string) => Promise<(EntitlementTeam & { teamId: string }) | null>;
  /** Distinct docs-corpus documents stored across the team's workspaces. */
  countTeamDocs?: (teamId: string) => Promise<number>;
  /** Which of `paths` this workspace already stores in its docs corpus. */
  storedDocPaths?: (workspaceId: string, paths: readonly string[]) => Promise<Set<string>>;
  env?: Env;
}

/**
 * Split an incoming batch of docs-corpus paths into what may be written and
 * what the plan's cap refuses. Billing off ⇒ everything, no DB read. Any
 * lookup failure ⇒ everything (fail open: never lose a paying team's ingest).
 */
export async function admitDocsWithinCap(
  workspaceId: string,
  paths: readonly string[],
  deps: KnowledgeBaseCapDeps = {},
): Promise<DocsAdmission> {
  const all: DocsAdmission = { admitted: [...paths], refused: [], cap: null, message: null };
  const env = deps.env ?? process.env;
  if (paths.length === 0 || !isBillingEnforced(env)) return all;
  try {
    const team = await (deps.loadWorkspaceTeam ?? loadWorkspaceTeam)(workspaceId);
    if (!team) return all;
    const cap = entitlements(team, { env }).knowledgeBaseCap;
    if (cap === null) return all;
    const [storedCount, alreadyStored] = await Promise.all([
      (deps.countTeamDocs ?? countTeamDocs)(team.teamId),
      (deps.storedDocPaths ?? storedDocPaths)(workspaceId, paths),
    ]);
    return planDocsAdmission({ cap, storedCount, alreadyStored, paths });
  } catch (e) {
    console.warn(`[billing] knowledge-base cap lookup failed for workspace ${workspaceId}:`, e);
    return all;
  }
}

async function loadWorkspaceTeam(workspaceId: string): Promise<(EntitlementTeam & { teamId: string }) | null> {
  const [{ db }, { teams, workspaces }, { eq }] = await Promise.all([
    import('./db'), import('./db/schema'), import('drizzle-orm'),
  ]);
  const [row] = await db
    .select({ teamId: teams.id, plan: teams.plan, paidSeats: teams.paidSeats })
    .from(workspaces)
    .innerJoin(teams, eq(teams.id, workspaces.teamId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row ?? null;
}

async function countTeamDocs(teamId: string): Promise<number> {
  const [{ db }, { knowledgeChunks, workspaces }, { and, eq, inArray, isNotNull, sql }] = await Promise.all([
    import('./db'), import('./db/schema'), import('drizzle-orm'),
  ]);
  const ws = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.teamId, teamId));
  if (ws.length === 0) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(distinct (${knowledgeChunks.namespace}, ${knowledgeChunks.sourcePath}))::int` })
    .from(knowledgeChunks)
    .where(and(
      inArray(knowledgeChunks.namespace, ws.map(w => `${w.id}:docs`)),
      isNotNull(knowledgeChunks.sourcePath),
    ));
  return Number(row?.n ?? 0);
}

async function storedDocPaths(workspaceId: string, paths: readonly string[]): Promise<Set<string>> {
  const [{ db }, { knowledgeChunks }, { and, eq, inArray }] = await Promise.all([
    import('./db'), import('./db/schema'), import('drizzle-orm'),
  ]);
  const rows = await db
    .selectDistinct({ path: knowledgeChunks.sourcePath })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.namespace, `${workspaceId}:docs`), inArray(knowledgeChunks.sourcePath, [...paths])));
  return new Set(rows.map(r => r.path).filter((p): p is string => typeof p === 'string'));
}
