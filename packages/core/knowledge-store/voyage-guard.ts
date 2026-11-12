// The one gate in front of every Voyage request. VoyageEmbedder and
// VoyageReranker call `admit` before they touch the network and `settle` after,
// so a new retrieval or ingest path is covered without knowing this exists.
// Spec: docs/specs/voyage-spend-guard.md.
//
// A denial is `null`, never a throw: callers degrade to lexical retrieval.

import { trace as otelTrace, SpanStatusCode } from '@opentelemetry/api';
import {
  isVoyageBudgetEnforced,
  isVoyageExempt,
  voyageBudgetState,
  voyageCapFor,
  voyageCapsForPlan,
  voyageMonth,
  voyageMonthResetsAt,
  VOYAGE_KEY_PURPOSE,
  type EmbeddingProvider,
  type VoyageBudgetState,
  type VoyageCaps,
  type VoyageKeySource,
  type VoyageKind,
} from '../voyage-budget';
import { loadPlatformRerankEnabled } from '../platform-rerank-switch';

type Env = Record<string, string | undefined>;

/** Whose spend a call is. Required on every client call, so it cannot be left out. */
export interface VoyageCall {
  /** `{workspaceId|teamId}:{corpus}`. */
  namespace: string;
  /** The code path, for attribution: `claim`, `recall`, `ingest`... */
  caller: string;
}

export interface VoyageRequest extends VoyageCall {
  kind: VoyageKind;
  model: string;
  estimatedTokens: number;
  inputType?: 'document' | 'query';
  /**
   * Absent or `voyage`: the Voyage rules below. `openai_compat`: an
   * OpenAI-compatible embedding endpoint, which is never capped by a Voyage
   * allowance or sent a Voyage key, but is still traced and attributed.
   */
  provider?: EmbeddingProvider;
  /** openai_compat only: the endpoint is configured as free (keySource `unmetered`). */
  unmetered?: boolean;
}

export interface VoyagePermit {
  /** The team's own key to call with. Absent: the client's platform key. */
  apiKey?: string;
  /** Report real usage; 0 refunds a failed call. Never throws, never blocks. */
  settle(actualTokens: number): void;
}

export interface VoyageGuard {
  /** A permit to make the call, or null when it must not be made. */
  admit(request: VoyageRequest): Promise<VoyagePermit | null>;
}

export interface VoyageTeam {
  teamId: string;
  plan: string | null;
}

export interface VoyageTrace {
  teamId: string | null;
  kind: VoyageKind;
  model: string;
  corpus: string;
  caller: string;
  keySource: VoyageKeySource;
  tokens: number;
  outcome: 'ok' | 'denied' | 'failed';
  provider: EmbeddingProvider;
}

export interface VoyageGuardDeps {
  env?: Env;
  now?: () => Date;
  /** The team behind a namespace owner (a workspace id or a team id). */
  resolveTeam(ownerId: string): Promise<VoyageTeam | null>;
  /** The team's own Voyage key, or null. */
  resolveOwnKey(teamId: string): Promise<string | null>;
  /** Atomically add `tokens` unless that passes `cap` (null: no limit). False = refused. */
  reserve(r: { teamId: string; month: string; kind: VoyageKind; tokens: number; cap: number | null }): Promise<boolean>;
  /** Apply `delta` to the monthly counter and add `tokens` to the daily attribution row. */
  settle(s: {
    teamId: string; month: string; day: string; kind: VoyageKind; model: string;
    corpus: string; caller: string; keySource: VoyageKeySource; delta: number; tokens: number;
  }): Promise<void>;
  /** Stamp the month as exhausted, so the team can be told. */
  markDenied(d: { teamId: string; month: string; kind: VoyageKind }): Promise<void>;
  trace(t: VoyageTrace): void;
  /**
   * The platform switch for reranking with the platform key (platform-rerank-switch.ts).
   * Read only for a `rerank` call that would use the platform key; off denies it.
   * Embeds and a team's own key never read it. Default: the shared switch.
   */
  platformRerankOn?(): Promise<boolean>;
}

/** How long a resolved team is trusted before it is read again. */
const TEAM_CACHE_TTL_MS = 60_000;
const TEAM_CACHE_MAX = 2_000;

function parseNamespace(namespace: string): { owner: string; corpus: string } {
  const [owner = '', corpus = 'unknown'] = (namespace ?? '').split(':');
  return { owner, corpus };
}

export function createVoyageGuard(deps: VoyageGuardDeps): VoyageGuard {
  const teams = new Map<string, { team: VoyageTeam; at: number }>();
  const ownKeys = new Map<string, { key: string | null; at: number }>();
  const nowOf = () => deps.now?.() ?? new Date();

  function remember<V>(cache: Map<string, V>, key: string, value: V): void {
    if (cache.size >= TEAM_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, value);
  }

  /** The namespace's team. Null when it cannot be determined: never a guess (spec R-4). */
  async function teamOf(owner: string): Promise<VoyageTeam | null> {
    const now = nowOf().getTime();
    const cached = teams.get(owner);
    if (cached && now - cached.at < TEAM_CACHE_TTL_MS) return cached.team;
    try {
      const team = await deps.resolveTeam(owner);
      if (team) remember(teams, owner, { team, at: now });
      return team;
    } catch (err) {
      console.warn(`[voyage-guard] team lookup failed for ${owner}:`, err);
      return null;
    }
  }

  /** The team's own key. An unreadable one is no key: the plan then decides. */
  async function ownKeyOf(teamId: string): Promise<string | null> {
    const now = nowOf().getTime();
    const cached = ownKeys.get(teamId);
    if (cached && now - cached.at < TEAM_CACHE_TTL_MS) return cached.key;
    try {
      const key = await deps.resolveOwnKey(teamId);
      remember(ownKeys, teamId, { key, at: now });
      return key;
    } catch (err) {
      console.warn(`[voyage-guard] own-key lookup failed for team ${teamId}:`, err);
      return null;
    }
  }

  return {
    async admit(request) {
      const { owner, corpus } = parseNamespace(request.namespace);
      const env = deps.env ?? process.env;
      const enforced = isVoyageBudgetEnforced(env);
      const provider: EmbeddingProvider = request.provider ?? 'voyage';
      const traced = (teamId: string | null, keySource: VoyageKeySource, tokens: number, outcome: VoyageTrace['outcome']) =>
        deps.trace({ teamId, kind: request.kind, model: request.model, corpus, caller: request.caller, keySource, tokens, outcome, provider });

      // An OpenAI-compatible endpoint: not Voyage's money, so no Voyage allowance,
      // key or switch applies. Every call is still traced, and attributed to the
      // team in the daily rows (keySource `endpoint`, or `unmetered` when free),
      // so get_embedding_usage shows it. The monthly Voyage counter is not touched.
      if (provider === 'openai_compat') {
        const keySource: VoyageKeySource = request.unmetered ? 'unmetered' : 'endpoint';
        const team = await teamOf(owner);
        return {
          settle(raw) {
            const tokens = Math.max(0, Math.floor(raw));
            traced(team?.teamId ?? null, keySource, tokens, tokens > 0 ? 'ok' : 'failed');
            if (!team || tokens === 0) return;
            void deps.settle({
              teamId: team.teamId, month: voyageMonth(nowOf()), day: nowOf().toISOString().slice(0, 10),
              kind: request.kind, model: request.model, corpus, caller: request.caller, keySource, delta: 0, tokens,
            }).catch(err => console.warn('[voyage-guard] settle failed:', err));
          },
        };
      }
      const deny = (teamId: string | null): null => {
        traced(teamId, 'platform', 0, 'denied');
        return null;
      };
      const unmetered = (teamId: string | null): VoyagePermit => ({
        settle: tokens => traced(teamId, 'platform', tokens, tokens > 0 ? 'ok' : 'failed'),
      });

      // The platform switch denies rerank on the platform key while off. Checked
      // only where the call would use the platform key, so embeds and BYOK are unaffected.
      const platformAllowed = async (): Promise<boolean> => {
        if (request.kind !== 'rerank') return true;
        try {
          return await (deps.platformRerankOn ?? loadPlatformRerankEnabled)();
        } catch {
          return false;
        }
      };

      const team = await teamOf(owner);
      if (!team) {
        if (!(await platformAllowed())) return deny(null);
        return enforced ? deny(null) : unmetered(null);
      }

      const { teamId } = team;
      const now = nowOf();
      const month = voyageMonth(now);
      const record = (keySource: VoyageKeySource, tokens: number, delta: number) => {
        traced(teamId, keySource, tokens, tokens > 0 ? 'ok' : 'failed');
        // Not awaited: a lost settle leaves the high estimate on the counter,
        // which errs towards refusing (spec R-2).
        void deps.settle({
          teamId, month, day: nowOf().toISOString().slice(0, 10), kind: request.kind, model: request.model,
          corpus, caller: request.caller, keySource, delta, tokens,
        }).catch(err => console.warn('[voyage-guard] settle failed:', err));
      };

      // The team's own key first, on any plan: it is their bill, not an allowance.
      const apiKey = await ownKeyOf(teamId);
      if (apiKey) {
        return { apiKey, settle: raw => record('byok', Math.max(0, Math.floor(raw)), 0) };
      }

      if (!(await platformAllowed())) return deny(teamId);

      const capped = enforced && !isVoyageExempt(teamId, env);
      const cap = capped ? voyageCapFor(voyageCapsForPlan(team.plan, env), request.kind, request.inputType) : null;

      // No platform allowance at all: the everyday state of a Free team, so it
      // costs no write and stamps nothing.
      if (cap === 0) return deny(teamId);

      const refuse = () => {
        deps.markDenied({ teamId, month, kind: request.kind }).catch(err => console.warn('[voyage-guard] mark denied failed:', err));
        return deny(teamId);
      };
      if (cap !== null && request.estimatedTokens > cap) return refuse();

      let reserved: boolean;
      try {
        reserved = await deps.reserve({ teamId, month, kind: request.kind, tokens: request.estimatedTokens, cap });
      } catch (err) {
        // The plan is known and allows the platform key; only the meter failed.
        console.warn(`[voyage-guard] reserve failed for team ${teamId}:`, err);
        return unmetered(teamId);
      }
      if (!reserved) return refuse();

      return {
        settle(raw) {
          const tokens = Math.max(0, Math.floor(raw));
          record('platform', tokens, tokens - request.estimatedTokens);
        },
      };
    },
  };
}

// ── Database half ────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function dbTools() {
  const [{ db }, { sql }] = await Promise.all([import('../db'), import('drizzle-orm')]);
  return { db, sql };
}

async function resolveOwnKeyFromDb(teamId: string): Promise<string | null> {
  const { db, sql } = await dbTools();
  const res = await db.execute(sql`
    SELECT encrypted_value FROM secrets
    WHERE team_id = ${teamId}::uuid AND purpose = ${VOYAGE_KEY_PURPOSE}
      AND account_id IS NULL AND workspace_id IS NULL AND user_id IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = (res.rows as Array<{ encrypted_value: string }>)[0];
  if (!row) return null;
  const { decrypt } = await import('../secrets');
  return decrypt(row.encrypted_value).trim() || null;
}

async function resolveTeamFromDb(ownerId: string): Promise<VoyageTeam | null> {
  if (!UUID_RE.test(ownerId)) return null;
  const { db, sql } = await dbTools();
  const res = await db.execute(sql`
    SELECT t.id::text AS team_id, t.plan
    FROM teams t
    LEFT JOIN workspaces w ON w.team_id = t.id AND w.id = ${ownerId}::uuid
    WHERE t.id = ${ownerId}::uuid OR w.id IS NOT NULL
    LIMIT 1
  `);
  const row = (res.rows as Array<{ team_id: string; plan: string | null }>)[0];
  return row ? { teamId: row.team_id, plan: row.plan } : null;
}

const tracer = otelTrace.getTracer('buildd-voyage');

/** One span per call, so spend is readable in traces by team, model, corpus and caller. */
function traceToOtel(t: VoyageTrace): void {
  try {
    const span = tracer.startSpan('voyage.call');
    span.setAttribute('voyage.kind', t.kind);
    span.setAttribute('voyage.model', t.model);
    span.setAttribute('voyage.corpus', t.corpus);
    span.setAttribute('voyage.caller', t.caller);
    span.setAttribute('voyage.key_source', t.keySource);
    span.setAttribute('voyage.tokens', t.tokens);
    span.setAttribute('voyage.outcome', t.outcome);
    span.setAttribute('embedding.provider', t.provider);
    if (t.teamId) span.setAttribute('voyage.team_id', t.teamId);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  } catch {
    // Telemetry never reaches the caller.
  }
}

const dbDeps: VoyageGuardDeps = {
  resolveTeam: resolveTeamFromDb,
  resolveOwnKey: resolveOwnKeyFromDb,
  async reserve({ teamId, month, kind, tokens, cap }) {
    const { db, sql } = await dbTools();
    const limit = cap === null ? sql`` : sql`WHERE voyage_usage_monthly.tokens + EXCLUDED.tokens <= ${cap}`;
    const res = await db.execute(sql`
      INSERT INTO voyage_usage_monthly (team_id, month, kind, tokens, calls, updated_at)
      VALUES (${teamId}::uuid, ${month}, ${kind}, ${tokens}, 1, NOW())
      ON CONFLICT (team_id, month, kind) DO UPDATE SET
        tokens = voyage_usage_monthly.tokens + EXCLUDED.tokens,
        calls = voyage_usage_monthly.calls + 1,
        updated_at = NOW()
      ${limit}
      RETURNING tokens
    `);
    return res.rows.length > 0;
  },
  async settle({ teamId, month, day, kind, model, corpus, caller, keySource, delta, tokens }) {
    const { db, sql } = await dbTools();
    await Promise.all([
      delta === 0 ? Promise.resolve() : db.execute(sql`
        UPDATE voyage_usage_monthly
        SET tokens = GREATEST(tokens + ${delta}, 0), updated_at = NOW()
        WHERE team_id = ${teamId}::uuid AND month = ${month} AND kind = ${kind}
      `),
      tokens === 0 ? Promise.resolve() : db.execute(sql`
        INSERT INTO voyage_usage_daily (day, team_id, kind, model, corpus, caller, key_source, tokens, calls)
        VALUES (${day}::date, ${teamId}::uuid, ${kind}, ${model}, ${corpus}, ${caller}, ${keySource}, ${tokens}, 1)
        ON CONFLICT (day, team_id, kind, model, corpus, caller, key_source) DO UPDATE SET
          tokens = voyage_usage_daily.tokens + EXCLUDED.tokens,
          calls = voyage_usage_daily.calls + 1
      `),
    ]);
  },
  async markDenied({ teamId, month, kind }) {
    const { db, sql } = await dbTools();
    await db.execute(sql`
      INSERT INTO voyage_usage_monthly (team_id, month, kind, tokens, calls, denied_calls, exhausted_at, updated_at)
      VALUES (${teamId}::uuid, ${month}, ${kind}, 0, 0, 1, NOW(), NOW())
      ON CONFLICT (team_id, month, kind) DO UPDATE SET
        denied_calls = voyage_usage_monthly.denied_calls + 1,
        exhausted_at = COALESCE(voyage_usage_monthly.exhausted_at, NOW()),
        updated_at = NOW()
    `);
  },
  trace: traceToOtel,
};

let defaultGuard: VoyageGuard | null = null;

/** The process-wide guard, over the database. */
export function getVoyageGuard(): VoyageGuard {
  defaultGuard ??= createVoyageGuard(dbDeps);
  return defaultGuard;
}

// ── Reading where a team stands ──────────────────────────────────────────────

export interface VoyageBudgetStatus {
  enforced: boolean;
  state: VoyageBudgetState;
  used: { embed: number; rerank: number };
  caps: VoyageCaps;
  resetsAt: string;
  /** The plain notice for the team, or null when there is nothing to say. */
  message: string | null;
}

export function voyageBudgetMessage(state: VoyageBudgetState, resetsAt: Date): string | null {
  const when = resetsAt.toISOString().slice(0, 10);
  if (state === 'lexical_only') {
    return 'Knowledge search runs on keywords on this plan. For semantic search, add your own Voyage key or upgrade in Settings → Billing.';
  }
  if (state === 'over') {
    return `This team has used its monthly knowledge search allowance. New content is stored without embeddings and ` +
      `search runs on keywords only until ${when}. Adding your own Voyage key lifts this.`;
  }
  if (state === 'near') {
    return `This team has used most of its monthly knowledge search allowance. It resets on ${when}.`;
  }
  return null;
}

/** Where a workspace's team stands this month. Null when the workspace has no team. */
export async function getWorkspaceVoyageBudget(
  workspaceId: string,
  opts: { env?: Env; now?: Date } = {},
): Promise<VoyageBudgetStatus | null> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const team = await resolveTeamFromDb(workspaceId);
  if (!team) return null;
  const { db, sql } = await dbTools();
  const res = await db.execute(sql`
    SELECT kind, tokens, exhausted_at FROM voyage_usage_monthly
    WHERE team_id = ${team.teamId}::uuid AND month = ${voyageMonth(now)}
  `);
  const rows = res.rows as Array<{ kind: VoyageKind; tokens: string | number; exhausted_at: string | null }>;
  const used = { embed: 0, rerank: 0 };
  for (const r of rows) used[r.kind] = Number(r.tokens);
  const ownKey = await resolveOwnKeyFromDb(team.teamId).catch(() => null);
  const enforced = isVoyageBudgetEnforced(env) && !isVoyageExempt(team.teamId, env) && !ownKey;
  const caps: VoyageCaps = enforced ? voyageCapsForPlan(team.plan, env) : { embed: null, rerank: null };
  const state = enforced ? voyageBudgetState(used, caps, rows.some(r => r.exhausted_at)) : 'ok';
  const resetsAt = voyageMonthResetsAt(now);
  return { enforced, state, used, caps, resetsAt: resetsAt.toISOString(), message: voyageBudgetMessage(state, resetsAt) };
}
