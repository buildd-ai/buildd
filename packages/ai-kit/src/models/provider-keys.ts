/** Client-safe projection of route capabilities. No SDK, environment, DB or secrets. */
import { ROUTES, ROUTE_IDS, type RouteId, type RouteSpec } from './routes';

export interface ProviderKeyCapability {
  id: RouteId;
  label: string;
  personalKeys: boolean;
  prefix: string;
  placeholder: string;
  consoleUrl: string;
  rejectedPrefixes: readonly string[];
  purposes: readonly string[];
  validation: { minLength: number; allowWhitespace: boolean; prefixIsHint: boolean };
  verification: {
    baseURL: string | null;
    path: string;
    auth: 'x-api-key' | 'bearer';
    method: 'GET';
    rejectedStatuses: readonly number[];
  };
}

export const PROVIDER_KEY_CAPABILITIES: readonly ProviderKeyCapability[] = ROUTE_IDS.map(id => {
  const route: RouteSpec = ROUTES[id];
  return {
    id, label: route.label, personalKeys: route.personalKeys,
    prefix: route.key?.prefix ?? '', placeholder: route.key?.placeholder ?? '',
    consoleUrl: route.key?.consoleUrl ?? '', rejectedPrefixes: route.key?.rejectedPrefixes ?? [],
    purposes: ['inference_key', ...(route.key?.legacyPurposes ?? [])],
    validation: { minLength: 20, allowWhitespace: false, prefixIsHint: true },
    verification: { baseURL: route.baseURL, path: route.verifyPath, auth: route.auth, method: 'GET', rejectedStatuses: [401, 403] },
  };
});

/** Standalone keys: gateways carry a URL/configuration and remain team-only. */
export type PersonalKeyProvider = {
  [R in RouteId]: (typeof ROUTES)[R]['personalKeys'] extends true ? R : never
}[RouteId];
export const PERSONAL_KEY_PROVIDERS: readonly PersonalKeyProvider[] = PROVIDER_KEY_CAPABILITIES
  .filter(p => p.personalKeys).map(p => p.id as PersonalKeyProvider);

export function isPersonalKeyProvider(value: unknown): value is PersonalKeyProvider {
  return typeof value === 'string' && (PERSONAL_KEY_PROVIDERS as readonly string[]).includes(value);
}

export function providerKeyCapability(value: unknown): ProviderKeyCapability | null {
  return PROVIDER_KEY_CAPABILITIES.find(p => p.id === value) ?? null;
}
