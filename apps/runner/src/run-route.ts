/**
 * Which route a run reached its model by, and how its dollars read (spec
 * "Runner on your terminal", section "Which login each run uses", R-39 to R-42).
 *
 * A route is one of four buckets:
 *   - plan:    a subscription login (Claude, ChatGPT). Paid by the plan.
 *   - api_key: a provider's own key (Anthropic, OpenAI). Per token.
 *   - gateway: OpenRouter, LiteLLM or a custom endpoint. Per token.
 *   - cloud:   Bedrock, Vertex, Foundry. Per token, by that account.
 * plus whose credential it is: this machine's, the person's own, or the team's.
 *
 * Derived from the same inputs as the cost basis (cost-basis.ts), in the same
 * precedence, when the runner builds the agent env. Never from the requested
 * backend or the account: a run moved by failover shows what it ran on.
 *
 * Dollars. Nothing in the agent stack reports a charge: the Claude SDK's
 * `total_cost_usd` / `modelUsage.costUSD` are Claude Code's own list-price
 * figures ("an estimate, not a billing statement"), the Codex SDK reports
 * tokens only (the runner prices them, codex-backend.ts), and a gateway's
 * charge (OpenRouter's `usage.cost`) never reaches the runner through Claude
 * Code or Codex. So:
 *   - Claude on an Anthropic API key: billed. The key is charged at
 *     Anthropic's published price for the tokens it reported, which is the
 *     price list Claude Code uses. A model that list does not know reads as
 *     estimated instead.
 *   - Codex on an OpenAI key: estimated. Its price comes from the OpenRouter
 *     catalog or a static family fallback, not OpenAI's own list.
 *   - gateway, cloud: estimated ("~"). The gateway or account sets its own
 *     price and reports no charge we can read.
 *   - plan: no dollar figure; the list-price value is "covered by the plan".
 *   - no route: estimated only when the basis is `real`; a plan basis is plan;
 *     an unknown basis has no dollar figure at all (the row keeps its tokens
 *     and Today leaves it out), since it may well be a plan.
 * Totals keep the three apart; nothing estimated or plan-covered is ever added
 * into billed.
 *
 * Pure: no I/O.
 */
import { catalogPriceFor, estimateCostUsdFromTotals, knownPriceForModel } from '@buildd/core/model-prices';
import { applyModelEnv } from './agent-model-env';
import { codexAuthJsonKind, CLOUD_MODEL_AUTH_ENV, isCredentialSet } from './cost-basis';
import { modelAuthSourceMode, stripInheritedApiKeys } from './model-auth-source';

export type RouteBucket = 'plan' | 'api_key' | 'gateway' | 'cloud';
export type RouteProvider = 'anthropic' | 'openai' | 'openrouter' | 'litellm' | 'custom' | 'bedrock' | 'vertex' | 'foundry';
/** Whose credential: this machine's, the requester's own (personal key policy), or the team's. */
export type RouteOwner = 'machine' | 'personal' | 'team';
export type RouteBackend = 'claude' | 'codex';

export interface RunRoute {
  backend: RouteBackend;
  bucket: RouteBucket;
  provider: RouteProvider;
  owner: RouteOwner;
  /** A gateway's name when the provider alone does not say it: the endpoint's host for a custom one. */
  label?: string;
}

/** The team endpoint fields a route reads. Never the key. */
export interface RouteEndpoint {
  kind: 'gateway' | 'openrouter' | 'anthropic-compatible' | 'cloudflare' | string;
  baseUrl?: string;
  openAiBaseUrl?: string;
  upstream?: 'anthropic' | 'openrouter';
}

/** The claim's credential scope (credentialDecision.scope); `personal` = the requester's own key. */
export type CredentialScope = 'personal' | 'team' | 'none' | undefined;

// The cost basis's own predicate: a route and its basis read the same env the same way.
const set = isCredentialSet;

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

const isOpenRouterHost = (host: string | undefined) => !!host && (host === 'openrouter.ai' || host.endsWith('.openrouter.ai'));

/** A gateway route for a base URL the machine set: OpenRouter by its host, else named by its host. */
function machineGateway(backend: RouteBackend, url: string | undefined): RunRoute {
  const host = hostOf(url);
  if (isOpenRouterHost(host)) return { backend, bucket: 'gateway', provider: 'openrouter', owner: 'machine' };
  return { backend, bucket: 'gateway', provider: 'custom', owner: 'machine', ...(host ? { label: host } : {}) };
}

/** The team's agent model endpoint, by its kind. */
export function teamEndpointRoute(backend: RouteBackend, endpoint: RouteEndpoint | undefined, scope: CredentialScope): RunRoute {
  const owner: RouteOwner = scope === 'personal' ? 'personal' : 'team';
  const base = { backend, bucket: 'gateway' as const, owner };
  switch (endpoint?.kind) {
    case 'openrouter': return { ...base, provider: 'openrouter' };
    case 'gateway': return { ...base, provider: 'litellm' };
    case 'cloudflare': return { ...base, provider: 'custom', label: 'Cloudflare AI Gateway' };
    default: {
      const host = hostOf(endpoint?.baseUrl ?? endpoint?.openAiBaseUrl);
      if (isOpenRouterHost(host)) return { ...base, provider: 'openrouter' };
      return { ...base, provider: 'custom', ...(host ? { label: host } : {}) };
    }
  }
}

const CLOUD_SWITCHES: Array<[string, RouteProvider]> = [
  ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'],
  ['CLAUDE_CODE_USE_VERTEX', 'vertex'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'foundry'],
];

function cloudSwitch(env: Record<string, string | undefined>): RouteProvider | null {
  for (const [k, provider] of CLOUD_SWITCHES) if (set(env[k]) && env[k] !== '0') return provider;
  return null;
}

export interface ClaudeRouteInput {
  /** applyModelEnv's result. */
  modelEnv: {
    env: Record<string, string | undefined>;
    endpoint: 'anthropic' | 'trusted' | 'team' | 'custom';
    machineLoginUsed?: boolean;
    injected?: string[];
    baseUrlOrigin?: string;
  };
  /** shouldUseClaudeCredential for this run: the claim's Claude seat was written into the session. */
  claudeCredentialUsed: boolean;
  /** This runner's own LLM_PROVIDER, when it applied (runnerLocalAllowed). */
  llmProvider?: { provider?: string; baseUrl?: string } | null;
  /** The team endpoint the claim delivered. */
  teamEndpoint?: RouteEndpoint;
  credentialScope?: CredentialScope;
}

/**
 * A Claude run's route. Precedence mirrors claudeCostBasis: a team endpoint or
 * a custom host, then a cloud account, then an API key in the env, then a
 * subscription token. Null when nothing determines it (basis `unknown`).
 */
export function claudeRunRoute(input: ClaudeRouteInput): RunRoute | null {
  const { modelEnv, credentialScope } = input;
  const env = modelEnv.env;
  const injected = modelEnv.injected ?? [];
  const serverOwner: RouteOwner = credentialScope === 'personal' ? 'personal' : 'team';
  if (modelEnv.endpoint === 'team') return teamEndpointRoute('claude', input.teamEndpoint, credentialScope);
  if (modelEnv.endpoint === 'custom') {
    if (input.llmProvider?.provider === 'openrouter') {
      // OpenRouter on its own host, or wherever the machine pointed it.
      const host = hostOf(input.llmProvider.baseUrl);
      if (!host || isOpenRouterHost(host)) return { backend: 'claude', bucket: 'gateway', provider: 'openrouter', owner: 'machine' };
    }
    return machineGateway('claude', input.llmProvider?.baseUrl ?? env.ANTHROPIC_BASE_URL ?? modelEnv.baseUrlOrigin);
  }
  const cloud = cloudSwitch(env);
  if (cloud) return { backend: 'claude', bucket: 'cloud', provider: cloud, owner: 'machine' };
  if (set(env.ANTHROPIC_AUTH_TOKEN) || set(env.ANTHROPIC_API_KEY)) {
    const owner: RouteOwner = injected.includes('serverApiKey') ? serverOwner : 'machine';
    // An operator-trusted proxy that forwards to Anthropic: per token, through that host.
    if (modelEnv.endpoint === 'trusted') {
      const host = hostOf(env.ANTHROPIC_BASE_URL ?? modelEnv.baseUrlOrigin);
      return { backend: 'claude', bucket: 'gateway', provider: 'custom', owner, ...(host ? { label: host } : {}) };
    }
    return { backend: 'claude', bucket: 'api_key', provider: 'anthropic', owner };
  }
  if (set(env.CLAUDE_CODE_OAUTH_TOKEN) || modelEnv.machineLoginUsed || input.claudeCredentialUsed) {
    let owner: RouteOwner = 'machine';
    if (!modelEnv.machineLoginUsed) {
      if (injected.includes('tenantOauthToken')) owner = 'team';
      else if (injected.includes('serverOauthToken') || input.claudeCredentialUsed) owner = serverOwner;
    }
    return { backend: 'claude', bucket: 'plan', provider: 'anthropic', owner };
  }
  return null;
}

export interface CodexRouteInput {
  /** applyModelEnv's endpoint for the Codex run. */
  endpoint: 'anthropic' | 'trusted' | 'team' | 'custom';
  teamEndpoint?: RouteEndpoint;
  /** Parsed `$CODEX_HOME/auth.json`, or null. */
  authJson: Record<string, unknown> | null;
  envApiKey?: string;
  /** The agent env's OPENAI_BASE_URL (the machine's own, when no team endpoint applied). */
  openAiBaseUrl?: string;
  /** decideCodexLogin: whose login the Codex home holds. */
  codexLogin?: 'machine' | 'server' | 'none';
  credentialScope?: CredentialScope;
}

/** A Codex run's route, in codexCostBasis's order. Null when nothing determines it. */
export function codexRunRoute(input: CodexRouteInput): RunRoute | null {
  if (input.endpoint === 'team') return teamEndpointRoute('codex', input.teamEndpoint, input.credentialScope);
  const serverOwner: RouteOwner = input.credentialScope === 'personal' ? 'personal' : 'team';
  const kind = codexAuthJsonKind(input.authJson);
  const keyRoute = (owner: RouteOwner): RunRoute =>
    set(input.openAiBaseUrl)
      ? { ...machineGateway('codex', input.openAiBaseUrl), owner }
      : { backend: 'codex', bucket: 'api_key', provider: 'openai', owner };
  if (kind === 'api_key') return keyRoute(input.codexLogin === 'server' ? serverOwner : 'machine');
  if (kind === 'chatgpt') return { backend: 'codex', bucket: 'plan', provider: 'openai', owner: input.codexLogin === 'server' ? serverOwner : 'machine' };
  if (set(input.envApiKey)) return keyRoute('machine');
  return null;
}

/**
 * A cloud run's route from its supervisor's hint (BUILDD_CLOUD_MODEL_AUTH).
 * The container holds only a placeholder key, so the hint says plan or per
 * token and nothing more: a metered run reads as the provider's key, the team's.
 */
export function cloudRunRoute(env: Record<string, string | undefined>, backend: RouteBackend): RunRoute | null {
  const v = env[CLOUD_MODEL_AUTH_ENV];
  const provider: RouteProvider = backend === 'codex' ? 'openai' : 'anthropic';
  if (v === 'owner_seat') return { backend, bucket: 'plan', provider, owner: 'team' };
  if (v === 'metered') return { backend, bucket: 'api_key', provider, owner: 'team' };
  return null;
}

// ── words ───────────────────────────────────────────────────────────────────

const PROVIDER_NAME: Record<RouteProvider, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', litellm: 'LiteLLM', custom: 'custom endpoint',
  bedrock: 'Bedrock', vertex: 'Vertex', foundry: 'Foundry',
};

export const BACKEND_NAME: Record<RouteBackend, string> = { claude: 'Claude', codex: 'Codex' };

export const BUCKET_NAME: Record<RouteBucket, string> = { plan: 'plan', api_key: 'API key', gateway: 'gateway', cloud: 'cloud account' };

/** What the route is called: the provider, or a custom gateway's host. */
export function providerName(route: Pick<RunRoute, 'provider' | 'label'>): string {
  return route.label ?? PROVIDER_NAME[route.provider];
}

/** " (team)", " (yours)", " (this machine)", or nothing where the machine's is the obvious owner. */
function ownerSuffix(route: RunRoute, machineToo: boolean): string {
  if (route.owner === 'team') return ' (team)';
  if (route.owner === 'personal') return ' (yours)';
  return machineToo ? ' (this machine)' : '';
}

/** The route in words, without the backend: "plan", "API key (team)", "OpenRouter (team)", "Bedrock". */
export function routeWords(route: RunRoute): string {
  switch (route.bucket) {
    case 'plan': return 'plan' + ownerSuffix(route, false);
    case 'api_key': return 'API key' + ownerSuffix(route, true);
    case 'gateway': return providerName(route) + ownerSuffix(route, true);
    case 'cloud': return providerName(route) + ownerSuffix(route, false);
  }
}

/** A run's backend and route: "Claude · plan", "Codex · OpenRouter (team)". Backend alone when unknown. */
export function runWords(backend: RouteBackend, route: RunRoute | null | undefined): string {
  return route ? `${BACKEND_NAME[route.backend]} · ${routeWords(route)}` : BACKEND_NAME[backend];
}

export const sameRoute = (a: RunRoute, b: RunRoute) =>
  a.backend === b.backend && a.bucket === b.bucket && a.provider === b.provider && a.owner === b.owner && (a.label ?? '') === (b.label ?? '');

// ── dollars ─────────────────────────────────────────────────────────────────

export type DollarKind = 'billed' | 'estimated' | 'plan';

export interface RunSpend {
  /** List-price dollars for the run's tokens so far. */
  usd: number;
  kind: DollarKind;
  /** The price list does not know the model: priced as a similar one, so estimated. */
  priceUnknown?: true;
}

/**
 * How a route's dollars read. No route: plan for a plan basis, estimated for
 * a per-token one, and null (no dollar figure) when the basis is unknown.
 */
export function dollarKind(route: RunRoute | null | undefined, costBasis?: string | null): DollarKind | null {
  if (!route) return costBasis === 'virtual' ? 'plan' : costBasis === 'real' ? 'estimated' : null;
  if (route.bucket === 'plan') return 'plan';
  // Only Anthropic's own key is priced from its provider's own list.
  if (route.bucket === 'api_key' && route.backend === 'claude') return 'billed';
  return 'estimated';
}

/** The ResultMeta fields spend reads. */
export interface SpendResultMeta {
  totalCostUsd?: number | null;
  modelUsage?: Record<string, { costUSD?: number } | undefined> | null;
  totalUsage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } | null;
  actualModel?: string | null;
}

const positive = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * A run's dollars, or null when it has none yet (no result reported, or no
 * model to price its tokens by). The figure is the backend's own list-price
 * total, else its tokens priced at list price (a plan run's SDK cost is 0).
 */
export function runSpend(input: {
  route?: RunRoute | null;
  costBasis?: string | null;
  backend?: RouteBackend;
  resultMeta?: SpendResultMeta | null;
  /** The model asked for, when the result does not name the one that ran. */
  model?: string | null;
}): RunSpend | null {
  const rm = input.resultMeta;
  if (!rm) return null;
  let kind = dollarKind(input.route, input.costBasis);
  if (!kind) return null;
  const model = rm.actualModel || input.model || null;
  let usd = positive(rm.totalCostUsd);
  if (!usd && rm.modelUsage) {
    for (const u of Object.values(rm.modelUsage)) usd += positive(u?.costUSD);
  }
  if (!usd && rm.totalUsage && model) usd = estimateCostUsdFromTotals(rm.totalUsage, model);
  if (!usd) return null;
  const backend = input.route?.backend ?? input.backend ?? 'claude';
  // Claude's list knows Claude models; a Codex model the catalog does not
  // carry was priced by codex-backend.ts's family fallback, a guess.
  const priceUnknown = !!model && (backend === 'codex' ? catalogPriceFor(model) === null : knownPriceForModel(model) === null);
  if (priceUnknown && kind === 'billed') kind = 'estimated';
  return { usd, kind, ...(priceUnknown ? { priceUnknown: true as const } : {}) };
}

export interface SpendTotals {
  billed: number;
  estimated: number;
  /** List-price value of plan usage: covered by the plan, never money spent. */
  plan: number;
}

/** Sum per kind. A figure only ever lands in its own kind. */
export function spendTotals(spends: Iterable<RunSpend | null | undefined>): SpendTotals {
  const t: SpendTotals = { billed: 0, estimated: 0, plan: 0 };
  for (const s of spends) if (s && s.usd > 0) t[s.kind] += s.usd;
  return t;
}

/** The worker fields spend reads: a LocalWorker, its public projection, or top's summary of it. */
export interface SpendWorker {
  route?: RunRoute | null;
  costBasis?: string | null;
  taskBackend?: string | null;
  resultMeta?: SpendResultMeta | null;
  sessionModel?: string;
  reportedModel?: string;
  /** Already worked out (top's worker summary carries it). */
  spend?: RunSpend | null;
  startedAt?: number;
  completedAt?: number;
  lastActivity?: number;
}

export function workerSpend(w: SpendWorker): RunSpend | null {
  if (w.spend !== undefined) return w.spend;
  return runSpend({
    route: w.route,
    costBasis: w.costBasis,
    backend: w.taskBackend === 'codex' ? 'codex' : 'claude',
    resultMeta: w.resultMeta,
    model: w.sessionModel ?? w.reportedModel ?? null,
  });
}

function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** Today's totals over the workers active today (by their last activity, end or start). */
export function todayTotals(workers: Iterable<SpendWorker>, now: number): SpendTotals {
  const today: Array<RunSpend | null> = [];
  for (const w of workers) {
    const at = w.completedAt ?? w.lastActivity ?? w.startedAt;
    if (typeof at === 'number' && sameLocalDay(at, now)) today.push(workerSpend(w));
  }
  return spendTotals(today);
}

export function formatUsd(usd: number): string {
  if (usd >= 10) return `$${Math.round(usd)}`;
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** A row's dollar figure: "$0.08" billed, "~$0.08" estimated, nothing for a plan run. */
export function rowDollars(spend: RunSpend | null | undefined): string | null {
  if (!spend || spend.kind === 'plan') return null;
  return (spend.kind === 'estimated' ? '~' : '') + formatUsd(spend.usd);
}

/** The detail's dollar line. */
export function detailDollars(spend: RunSpend | null | undefined, model?: string | null): string | null {
  if (!spend) return null;
  if (spend.kind === 'plan') return `about ${formatUsd(spend.usd)} at list price, covered by the plan`;
  if (spend.kind === 'billed') return `${formatUsd(spend.usd)} billed`;
  const why = spend.priceUnknown ? `, ${model ?? 'the model'} is not on the price list` : ', from tokens at list price';
  return `~${formatUsd(spend.usd)} estimated${why}`;
}

/** "Today: $2.10 billed, ~$0.40 estimated · plans covered about $41 at list price", or null when all are zero. */
export function todayLine(t: SpendTotals): string | null {
  const money = [
    t.billed > 0 ? `${formatUsd(t.billed)} billed` : null,
    t.estimated > 0 ? `~${formatUsd(t.estimated)} estimated` : null,
  ].filter(Boolean).join(', ');
  const plan = t.plan > 0 ? `plans covered about ${formatUsd(t.plan)} at list price` : '';
  const parts = [money, plan].filter(Boolean);
  return parts.length > 0 ? `Today: ${parts.join(' · ')}` : null;
}

// ── the runner's routes (header) ────────────────────────────────────────────

/** A route this runner cannot use right now, and where to fix it. */
export interface RouteProblem {
  backend: RouteBackend;
  /** "Codex plan: login expired, run codex login on this machine". */
  text: string;
}

/** A plan login whose last run the model provider refused. */
export interface LoginFailure {
  owner: RouteOwner;
  at: number;
  /**
   * For this machine's own login: a stamp of its credential store when the
   * run failed (host-seat.ts machineLoginStamp). A different stamp later means
   * the login was redone, so the failure is over. Absent: no stamp is readable.
   */
  stamp?: string | null;
}

export type LoginFailures = Partial<Record<RouteBackend, LoginFailure>>;

/**
 * A finished run's lesson about its login. A plan run that ended because the
 * model provider refused its login (`modelLoginFailed`, set only from the
 * backend's own auth signal: the SDK's `authentication_failed` /
 * `oauth_org_not_allowed`, a session that died on its first model call, an
 * expired Codex login) marks that backend's login expired. A tool, MCP or
 * git 401 in the transcript never does. A plan run that ended well clears it.
 */
export function nextLoginFailures(
  prev: LoginFailures,
  worker: { route?: RunRoute | null; status: string; modelLoginFailed?: boolean },
  now: number,
  stamp?: (backend: RouteBackend) => string | null,
): LoginFailures {
  const route = worker.route;
  if (!route || route.bucket !== 'plan') return prev;
  if (worker.status === 'error' && worker.modelLoginFailed) {
    const failure: LoginFailure = { owner: route.owner, at: now };
    if (route.owner === 'machine' && stamp) failure.stamp = stamp(route.backend);
    return { ...prev, [route.backend]: failure };
  }
  if (worker.status === 'done' && prev[route.backend]) {
    const next = { ...prev };
    delete next[route.backend];
    return next;
  }
  return prev;
}

/** Drop failures of this machine's logins whose credential store has changed since (a fresh login). */
export function clearRedoneLogins(failures: LoginFailures, stamp: (backend: RouteBackend) => string | null): LoginFailures {
  let next = failures;
  for (const backend of ['claude', 'codex'] as const) {
    const f = failures[backend];
    if (!f || f.owner !== 'machine' || f.stamp === undefined || f.stamp === null) continue;
    if (stamp(backend) !== f.stamp) {
      if (next === failures) next = { ...failures };
      delete next[backend];
    }
  }
  return next;
}

/** Async version: never blocks on keychain checks. */
export async function clearRedoneLoginsAsync(failures: LoginFailures, stamp: (backend: RouteBackend) => Promise<string | null>): Promise<LoginFailures> {
  let next = failures;
  for (const backend of ['claude', 'codex'] as const) {
    const f = failures[backend];
    if (!f || f.owner !== 'machine' || f.stamp === undefined || f.stamp === null) continue;
    if (await stamp(backend) !== f.stamp) {
      if (next === failures) next = { ...failures };
      delete next[backend];
    }
  }
  return next;
}

export interface MachineRoutesInput {
  /** The runner's own env (the agent env inherits its model variables). */
  env: Record<string, string | undefined>;
  /** This runner's LLM_PROVIDER. */
  llmProvider?: { provider?: string; baseUrl?: string } | null;
  /** host-seat.ts detectMachineLogin: this machine's own Claude login. */
  machineLogin?: 'env' | 'login' | null;
  /** Value of BUILDD_TRUSTED_MODEL_BASE_URL. */
  trustedBaseUrl?: string;
  /** This machine's parsed Codex auth.json, or null when there is none. */
  codexAuthJson?: Record<string, unknown> | null;
  /** Plan logins whose last run failed to authenticate, per backend. */
  loginFailures?: LoginFailures;
}

function expiredText(backend: RouteBackend, owner: RouteOwner): string {
  const fix = owner === 'machine'
    ? `run ${backend === 'codex' ? 'codex' : 'claude'} login on this machine`
    : 'reconnect in Settings › Credentials';
  return `${BACKEND_NAME[backend]} plan: login expired, ${fix}`;
}

/**
 * The routes this runner's own credentials give each backend (R-39), worked
 * out by the same functions as each run's route: the env a claim that
 * delivers nothing would build (applyModelEnv), then claudeRunRoute and
 * codexRunRoute. Routes a claim delivers (the team's key or endpoint) are not
 * here: the view adds them from the runs that used them.
 */
export function machineRoutes(input: MachineRoutesInput): { routes: RunRoute[]; problems: RouteProblem[] } {
  const routes: RunRoute[] = [];
  const problems: RouteProblem[] = [];
  const failed = input.loginFailures ?? {};

  // Claude: the agent env a bare claim would get.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env)) if (typeof v === 'string') env[k] = v;
  const providerSelected = input.llmProvider?.provider === 'openrouter' || set(input.llmProvider?.baseUrl);
  // BUILDD_MODEL_AUTH_SOURCE=runner: an inherited key is no consent to spend (model-auth-source.ts).
  if (modelAuthSourceMode(input.env) === 'runner' && !providerSelected && !set(env.ANTHROPIC_BASE_URL)) stripInheritedApiKeys(env);
  const modelEnv = applyModelEnv(env, {
    isCodexTask: false,
    llmProvider: input.llmProvider as any,
    machineLogin: input.machineLogin ?? null,
    trustedBaseUrl: input.trustedBaseUrl,
  });
  const claude = claudeRunRoute({ modelEnv, claudeCredentialUsed: false, llmProvider: input.llmProvider });
  if (claude?.bucket === 'plan' && failed.claude?.owner === 'machine') problems.push({ backend: 'claude', text: expiredText('claude', 'machine') });
  else if (claude) routes.push(claude);
  if (failed.claude && failed.claude.owner !== 'machine') problems.push({ backend: 'claude', text: expiredText('claude', failed.claude.owner) });

  // Codex: this machine's auth.json, else its OPENAI_API_KEY.
  const codex = codexRunRoute({
    endpoint: 'anthropic',
    authJson: input.codexAuthJson ?? null,
    envApiKey: input.env.OPENAI_API_KEY,
    openAiBaseUrl: input.env.OPENAI_BASE_URL,
    codexLogin: input.codexAuthJson ? 'machine' : 'none',
  });
  if (codex?.bucket === 'plan' && failed.codex?.owner === 'machine') problems.push({ backend: 'codex', text: expiredText('codex', 'machine') });
  else if (codex) routes.push(codex);
  if (failed.codex && failed.codex.owner !== 'machine') problems.push({ backend: 'codex', text: expiredText('codex', failed.codex.owner) });

  return { routes, problems };
}

const BUCKET_ORDER: RouteBucket[] = ['plan', 'api_key', 'gateway', 'cloud'];

/**
 * The header's "Runs on:" line (R-39): the routes grouped by bucket, each with
 * its backend or provider and whose credential it is, then any that do not
 * work. Null when there is nothing to say.
 */
export function runsOnLine(routes: RunRoute[], problems: RouteProblem[] = []): string | null {
  const unique: RunRoute[] = [];
  for (const r of routes) if (!unique.some(u => sameRoute(u, r))) unique.push(r);
  const groups: string[] = [];
  for (const bucket of BUCKET_ORDER) {
    const inBucket = unique.filter(r => r.bucket === bucket);
    if (inBucket.length === 0) continue;
    const items: string[] = [];
    for (const r of inBucket) {
      const owner = r.owner === 'team' ? ' (team)' : r.owner === 'personal' ? ' (yours)' : '';
      const name = bucket === 'plan' ? BACKEND_NAME[r.backend] : providerName(r);
      // One provider serving both backends is named once.
      const item = name + owner;
      if (!items.includes(item)) items.push(item);
    }
    groups.push(`${BUCKET_NAME[bucket]} ${items.join(', ')}`);
  }
  const parts = [...groups, ...problems.map(p => p.text)];
  return parts.length > 0 ? `Runs on: ${parts.join(' · ')}` : null;
}
