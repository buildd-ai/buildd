/**
 * Provider keys for chat (and other metered inference): client-safe helpers for
 * the Settings screens. No DB, no secrets, no server imports, so the team admin
 * page and the personal "You" page can both use it.
 *
 * The server side is `apps/web/src/lib/provider-keys.ts` plus
 * `/api/inference-keys`; the wire types are `@buildd/shared` (chat.ts). Values
 * never reach the browser: a key arrives as `last4` + health. Resolution order
 * (user → workspace → team) is `resolveInferenceKey` in
 * `@buildd/core/inference-keys`. See knowledge-base: buildd/design/agent-chat.md → Credentials.
 */
import {
  type ChatProvider,
  type ChatUses,
  type MaskedProviderKey,
  type ProviderKeyCapability,
} from '@buildd/shared';

import { PERSONAL_KEY_PROVIDERS, providerKeyCapability, isPersonalKeyProvider } from '@builddai/ai-kit/models/provider-keys';

export type { ChatProvider, ChatUses };

export interface ChatProviderInfo extends Omit<ProviderKeyCapability, 'id'> {
  id: ChatProvider;
}

/** OpenRouter is a display recommendation, never a routing requirement. */
export const PROVIDER_DISPLAY_ORDER: readonly ChatProvider[] = [...PERSONAL_KEY_PROVIDERS].sort((a, b) =>
  (a === 'openrouter' ? -1 : 0) - (b === 'openrouter' ? -1 : 0),
);

export const CHAT_PROVIDER_INFO: readonly ChatProviderInfo[] = PROVIDER_DISPLAY_ORDER.map(id => ({ ...providerKeyCapability(id)!, id }));
export const PERSONAL_PROVIDER_INFO = CHAT_PROVIDER_INFO.filter(p => p.personalKeys);

export type KeyPolicy = 'team' | 'team_or_own' | 'own';

function isKeyPolicy(v: unknown): v is KeyPolicy {
  return v === 'team' || v === 'team_or_own' || v === 'own';
}

export type KeyHealth = 'ok' | 'degraded' | 'failing' | 'unknown';

/** One stored key, as a card renders it. */
export interface ProviderKeyStatus {
  id: string;
  /** `…a1b2`. Never more of the key. */
  masked: string;
  health: KeyHealth;
  lastVerifiedAt: string | null;
  error: string | null;
  /**
   * False when the key serves chat from somewhere else (the runner's Anthropic
   * API key, a legacy OpenRouter decision key). The UI shows it but offers no
   * Replace / Remove / Test: those only act on `inference_key` rows.
   */
  managedHere: boolean;
  sourceNote: string | null;
}

export interface ProviderCard {
  provider: ChatProvider;
  team: ProviderKeyStatus | null;
  mine: ProviderKeyStatus | null;
  /** Admins only; null for members. */
  membersWithOwnKey: number | null;
}

export interface ProviderKeysView {
  canManageTeamKeys: boolean;
  providers: ProviderCard[];
  /** Whose key a person's chat turn spends. */
  keyPolicy: KeyPolicy;
  /**
   * What chat actually resolves to for this person, from the server's
   * resolver. Null: nothing resolves. Undefined: the server did not say, and
   * `chatKeySummary` falls back to reading the key list.
   */
  chatUses?: ChatUses | null;
}

const CHAT_USES_SCOPES: readonly ChatUses['scope'][] = ['user', 'account', 'workspace', 'team', 'env'];

function toChatUses(v: unknown): ChatUses | null | undefined {
  if (v === undefined) return undefined;
  const c = (v ?? {}) as Record<string, unknown>;
  if (!isPersonalKeyProvider(c.provider) || !CHAT_USES_SCOPES.includes(c.scope as ChatUses['scope'])) return null;
  return { provider: c.provider, scope: c.scope as ChatUses['scope'], ...(c.via === 'litellm' ? { via: 'litellm' as const } : {}) };
}

const SOURCE_NOTE: Record<string, string> = {
  anthropic_api_key: 'Your runners’ Anthropic API key, set under Settings, Runners. Chat uses it too. Change it there.',
  decision_key: 'An older OpenRouter setting holds this key. Chat uses it too.',
};

export function toKeyStatus(k: MaskedProviderKey | null | undefined): ProviderKeyStatus | null {
  if (!k) return null;
  const health: KeyHealth =
    k.health === 'healthy' ? 'ok'
      : k.health === 'revoked' ? 'failing'
        : k.health === 'degraded' ? 'degraded'
          : 'unknown';
  const managedHere = k.source === 'inference_key';
  return {
    id: k.id,
    masked: k.last4 ? `…${k.last4}` : 'set',
    health,
    lastVerifiedAt: k.lastVerifiedAt,
    error: k.lastVerificationError,
    managedHere,
    sourceNote: managedHere ? null : SOURCE_NOTE[k.source] ?? 'Set elsewhere. Manage it where it was added.',
  };
}

/**
 * Turn a `GET /api/inference-keys` body into one card per chat provider, in
 * display order. Providers missing from the body come back empty, and a
 * malformed body reads as "nothing configured" rather than throwing.
 */
export function normalizeProviderKeys(body: unknown): ProviderKeysView {
  const b = (body ?? {}) as { canManageTeamKeys?: unknown; providers?: unknown; keyPolicy?: unknown; chatUses?: unknown };
  const list = Array.isArray(b.providers) ? (b.providers as Record<string, unknown>[]) : [];
  const byProvider = new Map<ChatProvider, ProviderCard>();
  for (const p of list) {
    if (!p || !isPersonalKeyProvider(p.provider) || byProvider.has(p.provider)) continue;
    byProvider.set(p.provider, {
      provider: p.provider,
      team: toKeyStatus(p.team as MaskedProviderKey | null),
      mine: toKeyStatus(p.mine as MaskedProviderKey | null),
      membersWithOwnKey: typeof p.membersWithOwnKey === 'number' ? p.membersWithOwnKey : null,
    });
  }
  const chatUses = toChatUses(b.chatUses);
  return {
    canManageTeamKeys: b.canManageTeamKeys === true,
    providers: CHAT_PROVIDER_INFO.map(({ id: provider }) => byProvider.get(provider) ?? { provider, team: null, mine: null, membersWithOwnKey: null }),
    keyPolicy: isKeyPolicy(b.keyPolicy) ? b.keyPolicy : 'team',
    ...(chatUses !== undefined ? { chatUses } : {}),
  };
}

/** What a person's chat runs on, as the Account row says it. */
export type ChatKeySummary =
  | { kind: 'own'; provider: ChatProvider; via?: 'litellm' }
  /** `scope` is absent for the team key; `server` is the deployment's own key. */
  | { kind: 'team'; provider: ChatProvider; scope?: 'workspace' | 'server'; via?: 'litellm' }
  /** Everyone brings their own key, and this person has none yet. */
  | { kind: 'needs_own' }
  /** No team key yet. */
  | { kind: 'none' };

const usable = (k: ProviderKeyStatus | null) => !!k && k.health !== 'failing';

/**
 * Which key a person's chat uses under the team's policy. When the server sent
 * `chatUses` (the resolver's own answer: the tier's vendor first, then
 * OpenRouter, then the gateway) that is the answer. Otherwise, first provider
 * in display order: `team` ignores own keys, `own` never falls back to the
 * team key.
 */
export function chatKeySummary(view: Pick<ProviderKeysView, 'providers' | 'keyPolicy' | 'chatUses'>): ChatKeySummary {
  if (view.chatUses !== undefined) {
    const u = view.chatUses;
    if (!u) return view.keyPolicy === 'own' ? { kind: 'needs_own' } : { kind: 'none' };
    const via = u.via ? { via: u.via } : {};
    if (u.scope === 'user') return { kind: 'own', provider: u.provider, ...via };
    const scope = u.scope === 'workspace' ? { scope: 'workspace' as const } : u.scope === 'env' ? { scope: 'server' as const } : {};
    return { kind: 'team', provider: u.provider, ...scope, ...via };
  }
  if (view.keyPolicy !== 'team') {
    const mine = view.providers.find((p) => usable(p.mine));
    if (mine) return { kind: 'own', provider: mine.provider };
    if (view.keyPolicy === 'own') return { kind: 'needs_own' };
  }
  const team = view.providers.find((p) => usable(p.team));
  return team ? { kind: 'team', provider: team.provider } : { kind: 'none' };
}

/** Every key a person's chat can spend, one per provider. */
export type ChatKeysInUse =
  | { kind: 'keys'; keys: { provider: ChatProvider; whose: 'own' | 'team' }[] }
  | { kind: 'needs_own' }
  | { kind: 'none' };

/**
 * Like `chatKeySummary`, but every provider rather than the first: which key
 * serves a turn depends on the tier's vendor, so the team screen names them
 * all instead of guessing. Per provider, mirrors `resolveInferenceKey`.
 */
export function chatKeysInUse(view: Pick<ProviderKeysView, 'providers' | 'keyPolicy'>): ChatKeysInUse {
  const keys: { provider: ChatProvider; whose: 'own' | 'team' }[] = [];
  for (const p of view.providers) {
    if (view.keyPolicy !== 'team' && usable(p.mine)) keys.push({ provider: p.provider, whose: 'own' });
    else if (view.keyPolicy !== 'own' && usable(p.team)) keys.push({ provider: p.provider, whose: 'team' });
  }
  if (keys.length) return { kind: 'keys', keys };
  return view.keyPolicy === 'own' ? { kind: 'needs_own' } : { kind: 'none' };
}

/** Status square / chip tone for a key's health (lib/status-tone.ts). */
export function keyHealthTone(k: Pick<ProviderKeyStatus, 'health'> | null): 'success' | 'warning' | 'error' | 'muted' {
  if (!k) return 'muted';
  if (k.health === 'ok') return 'success';
  if (k.health === 'failing') return 'error';
  return 'warning';
}

export type KeySource = 'own' | 'workspace' | 'team' | 'none';

/**
 * Which key a chat turn uses, most specific first. Mirrors the server's
 * `resolveInferenceKey` order so the copy on the page matches what happens. A
 * key the provider rejected is skipped, like the server's healthy-over-revoked
 * tie-breaker.
 */
export function effectiveKeySource(s: {
  own: boolean; ownFailing?: boolean;
  workspace: boolean; workspaceFailing?: boolean;
  team: boolean; teamFailing?: boolean;
}): KeySource {
  if (s.own && !s.ownFailing) return 'own';
  if (s.workspace && !s.workspaceFailing) return 'workspace';
  if (s.team && !s.teamFailing) return 'team';
  return 'none';
}

export interface KeyShapeResult {
  ok: boolean;
  /** The sanitized value to send. */
  value: string;
  /** Error when !ok; a soft warning when ok. */
  message?: string;
}

/**
 * Trim, drop one pair of wrapping quotes, and check the prefix. The server runs
 * the same guard and then checks the key with the provider before storing it;
 * this one only saves a round trip on the obvious mistakes.
 */
export function checkKeyShape(provider: ChatProvider, raw: string): KeyShapeResult {
  let v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  if (!v) return { ok: false, value: v, message: 'Paste a key first.' };
  if (providerKeyCapability(provider)?.rejectedPrefixes.some(prefix => v.startsWith(prefix))) {
    return {
      ok: false,
      value: v,
      message: 'That is a Claude subscription token. Chat needs an API key from the Anthropic console.',
    };
  }
  const info = providerKeyCapability(provider)!;
  if (!v.startsWith(info.prefix)) {
    return { ok: true, value: v, message: `${info.label} keys usually start with ${info.prefix}.` };
  }
  return { ok: true, value: v };
}

export type PillTone = 'ok' | 'warn' | 'err' | 'idle';

export function keyHealthPill(k: Pick<ProviderKeyStatus, 'health'> | null): { tone: PillTone; label: string } {
  if (!k) return { tone: 'idle', label: 'not connected' };
  if (k.health === 'ok') return { tone: 'ok', label: 'working' };
  if (k.health === 'failing') return { tone: 'err', label: 'rejected' };
  if (k.health === 'degraded') return { tone: 'warn', label: 'degraded' };
  return { tone: 'warn', label: 'not tested' };
}

export function formatCheckedAgo(at: string | Date | null | undefined, now: Date = new Date()): string {
  if (!at) return 'never checked';
  const t = typeof at === 'string' ? new Date(at) : at;
  const s = Math.max(0, Math.round((now.getTime() - t.getTime()) / 1000));
  if (!Number.isFinite(s)) return 'never checked';
  if (s < 60) return 'checked just now';
  const m = Math.round(s / 60);
  if (m < 60) return `checked ${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `checked ${h}h ago`;
  return `checked ${Math.round(h / 24)}d ago`;
}
