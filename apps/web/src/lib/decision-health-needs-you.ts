/**
 * Decisions that all fail at the provider, as one Home card.
 *
 * A decision call never throws: on any failure it falls back to its rule. So a
 * team whose decision model cannot be reached (a Cloudflare token without
 * Workers AI, a revoked OpenRouter key) degrades on every call and nothing
 * says so. When at least `DECISION_HEALTH_FAILING_SHARE` of a team's
 * decisions in the last `DECISION_HEALTH_WINDOW_MS` were `provider_error`,
 * Home shows one card to the people who can change the decision model
 * (`manage_team_settings`), with the provider's own words and a link to the
 * setting.
 *
 * Read on Home with no model call, from the two decision ledgers
 * (`orchestration_decisions`: start/wait, file prediction, task verdict;
 * `decision_records`: decision kinds). No push: the card is the signal, and
 * it goes away by itself once decisions answer again.
 */
import { providerRejectionText } from '@buildd/core/decision-probe';
import type { WaitingOnYouRawItem } from './action-queue';

export const DECISION_HEALTH_WINDOW_MS = 30 * 60 * 1000;
export const DECISION_HEALTH_FAILING_SHARE = 0.9;
/** Below this many calls in the window a share means nothing. */
export const DECISION_HEALTH_MIN_CALLS = 5;
/** Where the decision model is set: Settings → Models → Routing. */
export const DECISION_MODEL_SETTING_HREF = '/app/settings/models#routing';

export interface DecisionHealthCounts {
  /** Decisions in the window that went to a model (or tried to). */
  calls: number;
  providerErrors: number;
  /** The newest provider rejection, `HTTP <status>: <excerpt>`, when one was recorded. */
  lastError: string | null;
}

type DecisionModel = { via?: unknown } | null | undefined;

export interface DecisionHealthVerdict { title: string; sentence: string }

function providerName(model: DecisionModel): { name: string; credential: 'token' | 'key' } {
  const via = model && typeof model === 'object' ? model.via : null;
  if (via === 'cloudflare') return { name: 'Cloudflare', credential: 'token' };
  if (via === 'litellm') return { name: 'the LiteLLM gateway', credential: 'key' };
  return { name: 'OpenRouter', credential: 'key' };
}

/** Pure. Null unless the team's decisions are failing at the provider. */
export function decisionHealthVerdict(c: DecisionHealthCounts, model: DecisionModel): DecisionHealthVerdict | null {
  if (c.calls < DECISION_HEALTH_MIN_CALLS || c.providerErrors < DECISION_HEALTH_FAILING_SHARE * c.calls) return null;
  const { name, credential } = providerName(model);
  const status = Number(/^HTTP (\d{3})/.exec(c.lastError ?? '')?.[1]);
  const what = status === 401 || status === 403 ? `rejected the ${credential}` : 'is returning errors';
  const head = `${c.providerErrors} of ${c.calls} decisions in the last ${Math.round(DECISION_HEALTH_WINDOW_MS / 60000)} minutes fell back to the rule.`;
  const said = readableProviderError(c.lastError);
  return {
    title: `Decisions are failing: ${name} ${what}`,
    sentence: said ? `${head} ${name[0].toUpperCase()}${name.slice(1)} said: ${said}` : head,
  };
}

/** Pure. The Needs you item: one per team, keyed so repeats fold into one card. */
export function decisionHealthItem(teamId: string, v: DecisionHealthVerdict): WaitingOnYouRawItem {
  return {
    kind: 'incident',
    incidentId: `decisions:${teamId}`,
    incidentTitle: v.title,
    failureMessage: v.sentence,
    fixHref: DECISION_MODEL_SETTING_HREF,
    fixLabel: 'Open decision model',
  };
}

/** `HTTP 401: {"errors":[…]}` as a person reads it: `HTTP 401: Authentication error (code 10000)`. */
export function readableProviderError(excerpt: string | null): string | null {
  const m = /^HTTP (\d{3})(?:: ([\s\S]*))?$/.exec(excerpt ?? '');
  return m ? providerRejectionText(Number(m[1]), m[2] ?? '') : excerpt;
}

/** The excerpt `toDecisionLedgerInput` puts in a decision kind's `reason` (`provider_error=HTTP 401: …`). */
export function providerErrorFromReason(reason: string | null | undefined): string | null {
  const m = /(?:^|; )provider_error=(HTTP \d{3}.*?)(?:; [a-z_]+=|$)/.exec(reason ?? '');
  return m ? m[1] : null;
}

export interface DecisionHealthDeps {
  /** The teams of these workspaces. */
  teamsOf: (workspaceIds: readonly string[]) => Promise<string[]>;
  canManage: (userId: string, teamId: string) => Promise<boolean>;
  readCounts: (teamId: string, since: Date) => Promise<DecisionHealthCounts>;
  readDecisionModel: (teamId: string) => Promise<unknown>;
  now?: () => number;
}

async function dbTeamsOf(workspaceIds: readonly string[]): Promise<string[]> {
  const [{ db }, { workspaces }, { inArray }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
  ]);
  const rows = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(inArray(workspaces.id, [...workspaceIds]));
  return [...new Set(rows.map(r => r.teamId).filter((t): t is string => !!t))];
}

async function dbCanManage(userId: string, teamId: string): Promise<boolean> {
  const { can } = await import('./permissions');
  return can({ kind: 'user', userId }, 'manage_team_settings', teamId);
}

async function dbReadDecisionModel(teamId: string): Promise<unknown> {
  const [{ db }, { teams }, { eq }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
  ]);
  const row = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { decisionModel: true } });
  return row?.decisionModel ?? null;
}

/**
 * Both ledgers' counts for one team in the window. A row counts as a call
 * when it got past the policy and key checks: nothing was spent on a
 * capability that is off or a team with no key, so those are not failures of
 * the model.
 */
async function dbReadCounts(teamId: string, since: Date): Promise<DecisionHealthCounts> {
  const [{ db }, { orchestrationDecisions, decisionRecords }, { and, desc, eq, gte, sql }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
  ]);
  const NOT_A_CALL = ['capability_disabled', 'missing_key', 'no_candidates', 'rule_decided', 'retrieval_error', 'sensitive'];
  const notACall = sql.join(NOT_A_CALL.map(r => sql`${r}`), sql`, `);

  const [orch] = await db.select({
    calls: sql<number>`count(*) filter (where coalesce(${orchestrationDecisions.reason}, '') not in (${notACall}))`.mapWith(Number),
    providerErrors: sql<number>`count(*) filter (where ${orchestrationDecisions.errorKind} = 'provider_error')`.mapWith(Number),
  }).from(orchestrationDecisions)
    .where(and(eq(orchestrationDecisions.teamId, teamId), gte(orchestrationDecisions.createdAt, since)));

  const kindProviderError = sql`(${decisionRecords.reason} = 'provider_error' or (${decisionRecords.status} = 'fallback' and ${decisionRecords.reason} like '%provider_error=%'))`;
  const [kinds] = await db.select({
    calls: sql<number>`count(*) filter (where coalesce(${decisionRecords.attemptCount}, 1) > 0 and coalesce(${decisionRecords.failureClass}, '') not in ('capability', 'key') and coalesce(${decisionRecords.reason}, '') not in (${notACall}))`.mapWith(Number),
    providerErrors: sql<number>`count(*) filter (where ${kindProviderError})`.mapWith(Number),
  }).from(decisionRecords)
    .where(and(eq(decisionRecords.teamId, teamId), gte(decisionRecords.createdAt, since)));

  const calls = (orch?.calls ?? 0) + (kinds?.calls ?? 0);
  const providerErrors = (orch?.providerErrors ?? 0) + (kinds?.providerErrors ?? 0);
  if (calls < DECISION_HEALTH_MIN_CALLS || providerErrors < DECISION_HEALTH_FAILING_SHARE * calls) {
    return { calls, providerErrors, lastError: null };
  }

  // Only for a failing team: the newest rejection's own words.
  const [lastOrch] = await db.select({ receipt: orchestrationDecisions.receipt, createdAt: orchestrationDecisions.createdAt })
    .from(orchestrationDecisions)
    .where(and(eq(orchestrationDecisions.teamId, teamId), gte(orchestrationDecisions.createdAt, since), eq(orchestrationDecisions.errorKind, 'provider_error')))
    .orderBy(desc(orchestrationDecisions.createdAt)).limit(1);
  const [lastKind] = await db.select({ reason: decisionRecords.reason, createdAt: decisionRecords.createdAt })
    .from(decisionRecords)
    .where(and(eq(decisionRecords.teamId, teamId), gte(decisionRecords.createdAt, since), kindProviderError))
    .orderBy(desc(decisionRecords.createdAt)).limit(1);

  const { providerErrorExcerpt } = await import('@builddai/ai-kit/decide');
  const orchError = (lastOrch?.receipt as { error?: unknown } | null)?.error as { status?: unknown; body?: unknown } | undefined;
  const fromOrch = typeof orchError?.status === 'number' && orchError.status
    ? providerErrorExcerpt(orchError.status, typeof orchError.body === 'string' ? orchError.body : '')
    : null;
  const fromKind = providerErrorFromReason(lastKind?.reason);
  const orchNewer = (lastOrch?.createdAt?.getTime() ?? 0) >= (lastKind?.createdAt?.getTime() ?? 0);
  return { calls, providerErrors, lastError: (orchNewer ? fromOrch ?? fromKind : fromKind ?? fromOrch) ?? null };
}

const DB_DEPS: DecisionHealthDeps = {
  teamsOf: dbTeamsOf,
  canManage: dbCanManage,
  readCounts: dbReadCounts,
  readDecisionModel: dbReadDecisionModel,
};

/**
 * Home's read: one item per team of these workspaces whose decisions are
 * failing at the provider, for a viewer who can change the decision model.
 * Never throws (Home keeps every other card).
 */
export async function loadDecisionHealthNeedsYou(
  userId: string | null | undefined,
  workspaceIds: readonly string[],
  deps: DecisionHealthDeps = DB_DEPS,
): Promise<WaitingOnYouRawItem[]> {
  if (!userId || workspaceIds.length === 0) return [];
  try {
    const since = new Date((deps.now ?? Date.now)() - DECISION_HEALTH_WINDOW_MS);
    const out: WaitingOnYouRawItem[] = [];
    for (const teamId of await deps.teamsOf(workspaceIds)) {
      if (!(await deps.canManage(userId, teamId))) continue;
      const verdict = decisionHealthVerdict(await deps.readCounts(teamId, since), (await deps.readDecisionModel(teamId)) as DecisionModel);
      if (verdict) out.push(decisionHealthItem(teamId, verdict));
    }
    return out;
  } catch (err) {
    console.warn('[decision-health] Home read failed (non-fatal):', (err as Error)?.message ?? err);
    return [];
  }
}
