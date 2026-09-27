/**
 * Client-safe helpers for Settings → Model tiers: which provider/model options a
 * tier can take, what "pinned" means, and how catalog audit notes read as
 * suggestions. No DB imports.
 *
 * Semantics come from the registry (packages/core/model-tier-registry.ts):
 * a team/workspace row is an admin's explicit choice (pinned, buildd never moves
 * it); no row means the tier follows the live catalog's newest model inside its
 * price band (auto). See docs/design/model-tiers.md and docs/design/agent-chat.md.
 */
import { TIER_PRICE_BANDS } from '@buildd/core/model-catalog';
import type { Tier, TierEntry, TierProvider } from '@buildd/core/model-tier-defaults';

export interface TierProviderOption {
  id: TierProvider;
  label: string;
  note?: string;
}

/** Providers `POST /api/model-tiers` accepts, in display order. */
export const TIER_PROVIDER_OPTIONS: readonly TierProviderOption[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI', note: 'API key. Server-side calls such as chat; runners cannot use it.' },
  { id: 'openai-codex', label: 'OpenAI Codex', note: 'Runner only. Uses a Codex seat, so chat cannot use it.' },
];

export function providerForModel(provider: string): TierProvider {
  return TIER_PROVIDER_OPTIONS.some((p) => p.id === provider) ? (provider as TierProvider) : 'anthropic';
}

export function providerLabel(provider: string): string {
  return TIER_PROVIDER_OPTIONS.find((p) => p.id === provider)?.label ?? provider;
}

/** Shape of one `/api/models` entry (see apps/web/src/app/api/models/route.ts). */
export interface CatalogModel {
  id: string;
  displayName: string;
  provider: string;
  tier?: Tier;
  openRouterId?: string;
  inputPrice?: number;
  outputPrice?: number;
  /** Picker metadata (see lib/model-picker.ts). */
  vendor?: string;
  contextLength?: number;
  created?: number;
  expiresAt?: number | null;
}

export interface TierSourceState {
  pinned: boolean;
  label: 'pinned' | 'auto';
  explain: string;
}

export function tierSourceState(source: TierEntry['source']): TierSourceState {
  if (source === 'team' || source === 'workspace') {
    return { pinned: true, label: 'pinned', explain: 'You chose this model. buildd won’t move it.' };
  }
  return {
    pinned: false,
    label: 'auto',
    explain: 'Follows the newest model in this tier’s price band.',
  };
}

function bandMoney(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export function tierBandLabel(tier: Tier): string {
  const band = TIER_PRICE_BANDS[tier];
  if (band.minInput === 0) return `under ${bandMoney(band.maxInput)} input per MTok`;
  return `${bandMoney(band.minInput)} to ${bandMoney(band.maxInput)} input per MTok`;
}

export interface TierAuditLike {
  checked: boolean;
  unknown: Array<{ tier: string; model: string }>;
  superseded: Array<{ tier: string; model: string; newer: string }>;
}

export type TierSuggestion =
  | { tier: string; kind: 'newer'; model: string; newer: string }
  | { tier: string; kind: 'missing'; model: string };

/**
 * Catalog notes the tier screen can show as read-only suggestions.
 *
 * These are catalog evidence (a newer release exists, a pinned id is gone), not
 * outcome evidence. They never apply themselves. A "missing" note is only
 * trustworthy against a complete catalog, so it is dropped otherwise.
 */
export function tierSuggestions(
  audit: TierAuditLike | undefined | null,
  opts: { catalogComplete?: boolean } = {},
): TierSuggestion[] {
  if (!audit?.checked) return [];
  const out: TierSuggestion[] = audit.superseded.map((s) => ({ tier: s.tier, kind: 'newer' as const, model: s.model, newer: s.newer }));
  if (opts.catalogComplete) {
    for (const u of audit.unknown) out.push({ tier: u.tier, kind: 'missing', model: u.model });
  }
  return out;
}

/**
 * Which surfaces can run a tier. The registry is shared: agent runs and chat
 * both ask for a tier, but a Codex seat only signs in a runner and an OpenAI
 * API key only serves server-side calls.
 */
export function tierUsedBy(provider: string): 'agent runs, chat' | 'agent runs only' | 'chat only' {
  if (provider === 'openai-codex') return 'agent runs only';
  if (provider === 'openai') return 'chat only';
  return 'agent runs, chat';
}

/** The one catalog note to show on a tier's row: a newer release wins over a missing id. */
export function suggestionFor(list: readonly TierSuggestion[], tier: string): TierSuggestion | null {
  const mine = list.filter((s) => s.tier === tier);
  return mine.find((s) => s.kind === 'newer') ?? mine[0] ?? null;
}
