/**
 * `@builddai/ai-kit/models`: the model-plan client (server side, no peers,
 * no framework deps; Node, Bun and edge).
 *
 * An app asks buildd for a plan (`tier` + `surface` + `kind`) and gets back
 * which model to call and whether it may spend. The app makes the call with
 * its own provider key, then records a content-free receipt. buildd never
 * sees prompts, tool results, replies, or who the app's user is.
 *
 * ```ts
 * const models = createModelsClient({ apiKey, providers: ['openrouter'], defaults });
 * const plan = await models.plan({ tier: 'standard', kind: 'chat_turn' }); // throws PlanDeniedError on deny
 * const cfg = toCallConfig(plan, { apiKeys: { openrouter: key } });
 * // ... make the call ...
 * models.recordUsage({ plan, tokens: { input, output }, costUsd, latencyMs, outcome: 'ok' });
 * await models.flush(); // before a serverless function returns
 * ```
 */

export * from './types';
export {
  createModelsClient, PlanDeniedError, isPlanDeniedError, DEFAULT_BASE_URL, PLAN_TIMEOUT_MS,
  type ModelsClient, type ModelsClientOptions, type ModelsClientEvent, type UsageStats,
} from './client';
export { memoryPlanStore, type PlanStore, type StoredPlan } from './store';
export { toWireReceipt, USAGE_RECORD_KEYS, USAGE_TOKEN_KEYS, MAX_USAGE_RECORDS } from './receipt';
export { toCallConfig, gatewayModel, PROVIDER_BASE_URLS, type CallConfig, type CallConfigOptions, type GatewayConfig } from './call-config';
export {
  ROUTES, ROUTE_IDS, isRouteId, routeServes, routeOrder, routeModelId, openRouterModelId,
  routeAuthHeaders, routeAttributionHeaders,
  type RouteId, type RouteSpec, type RouteWire, type GatewayNaming,
} from './routes';
