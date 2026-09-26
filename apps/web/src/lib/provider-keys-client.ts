/**
 * Provider keys for chat (and other metered inference): client-safe helpers for
 * the Settings screens. No DB, no secrets, no server imports, so the team admin
 * page and the personal "You" page can both use it.
 *
 * The server side is `apps/web/src/lib/provider-keys.ts` plus
 * `/api/inference-keys`; the wire types are `@buildd/shared` (chat.ts). Values
 * never reach the browser: a key arrives as `last4` + health. Resolution order
 * (user → workspace → team) is `resolveInferenceKey` in
 * `@buildd/core/inference-keys`. See docs/design/agent-chat.md → Credentials.
 */
import {
  CHAT_PROVIDERS,
  isChatProvider,
  type ChatProvider,
  type MaskedProviderKey,
} from '@buildd/shared';

export type { ChatProvider };

export interface ChatProviderInfo {
  id: ChatProvider;
  label: string;
  /** Expected key prefix, used for a soft shape check before saving. */
  prefix: string;
  placeholder: string;
  /** Where to create a key. */
  consoleUrl: string;
}

const INFO: Record<ChatProvider, Omit<ChatProviderInfo, 'id'>> = {
  anthropic: { label: 'Anthropic', prefix: 'sk-ant-api', placeholder: 'sk-ant-api03-…', consoleUrl: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'OpenAI', prefix: 'sk-', placeholder: 'sk-proj-…', consoleUrl: 'https://platform.openai.com/api-keys' },
  openrouter: { label: 'OpenRouter', prefix: 'sk-or-', placeholder: 'sk-or-v1-…', consoleUrl: 'https://openrouter.ai/settings/keys' },
};

/** Display info per provider, in the shared contract's order. */
export const CHAT_PROVIDER_INFO: readonly ChatProviderInfo[] = CHAT_PROVIDERS.map((id) => ({ id, ...INFO[id] }));

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
}

const SOURCE_NOTE: Record<string, string> = {
  anthropic_api_key: 'This is the runner’s Anthropic API key from Agent backends. Chat uses it too. Change it there.',
  decision_key: 'This is the OpenRouter decision key. Chat uses it too. Change it where it was set.',
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
  const b = (body ?? {}) as { canManageTeamKeys?: unknown; providers?: unknown };
  const list = Array.isArray(b.providers) ? (b.providers as Record<string, unknown>[]) : [];
  const byProvider = new Map<ChatProvider, ProviderCard>();
  for (const p of list) {
    if (!p || !isChatProvider(p.provider) || byProvider.has(p.provider)) continue;
    byProvider.set(p.provider, {
      provider: p.provider,
      team: toKeyStatus(p.team as MaskedProviderKey | null),
      mine: toKeyStatus(p.mine as MaskedProviderKey | null),
      membersWithOwnKey: typeof p.membersWithOwnKey === 'number' ? p.membersWithOwnKey : null,
    });
  }
  return {
    canManageTeamKeys: b.canManageTeamKeys === true,
    providers: CHAT_PROVIDERS.map((provider) => byProvider.get(provider) ?? { provider, team: null, mine: null, membersWithOwnKey: null }),
  };
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
  if (provider === 'anthropic' && v.startsWith('sk-ant-oat')) {
    return {
      ok: false,
      value: v,
      message: 'That is a Claude subscription token. Chat needs an API key from the Anthropic console.',
    };
  }
  const info = INFO[provider];
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
