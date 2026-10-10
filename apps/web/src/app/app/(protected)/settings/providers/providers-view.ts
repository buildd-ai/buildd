/**
 * What the Providers page shows for one provider at one scope tab, derived
 * from `GET /api/providers` only. Pure and db-free (client components import
 * it).
 *
 * Nothing here restates registry facts: what a provider serves, why it cannot
 * serve a surface, which scopes it can be stored at and what each stored row
 * serves today all come from the response, so a registry change shows up here
 * without an edit.
 */
import type {
  CredentialPolicyValue,
  ListProvidersResponse,
  ProviderApiScope,
  ProviderCredentialSummary,
  ProviderListing,
  ProviderPolicySummary,
  ProviderShapeId,
  ProviderSurfaceId,
  ProviderWritePermission,
} from '@buildd/shared';

export const SURFACE_ORDER: readonly ProviderSurfaceId[] = ['chat', 'agent-claude', 'agent-codex', 'cloud-egress'];

export const SURFACE_LABEL: Record<ProviderSurfaceId, string> = {
  chat: 'Chat',
  'agent-claude': 'Claude agents',
  'agent-codex': 'Codex agents',
  'cloud-egress': 'Cloud agents',
};

/** The same surfaces mid-sentence: "Used for chat and Claude agents." */
const SURFACE_PHRASE: Record<ProviderSurfaceId, string> = {
  chat: 'chat',
  'agent-claude': 'Claude agents',
  'agent-codex': 'Codex agents',
  'cloud-egress': 'cloud agents',
};

export const SHAPE_NOUN: Record<ProviderShapeId, string> = {
  api_key: 'API key',
  setup_token: 'Setup token',
  oauth_managed: 'Subscription login',
  gateway: 'Gateway',
  endpoint: 'Endpoint',
};

export const SCOPE_TABS: readonly { id: ProviderApiScope; label: string }[] = [
  { id: 'team', label: 'Team' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'mine', label: 'Mine' },
];

/** The LiteLLM gateway and custom endpoint forms: the Routing section further down this page. */
export const ADVANCED_ANCHOR = 'routing';

export const ADMINS_ONLY = 'Admins can change this.';
export const POLICY_BLOCKS_MINE = "Your team's policy doesn't use personal keys.";
export const MINE_NEEDS_PERSON = 'Personal keys belong to a signed-in person.';

type Can = ListProvidersResponse['caller']['can'];
export type WritePermission = keyof Can;

/**
 * Every permission a write of this shape at this scope needs, as the server
 * reports it (`writesTo[scope].permissions`, from `writePermissions` in
 * `@buildd/core/providers/manage`; a test holds them together). An Anthropic
 * or OpenAI key that agent runs read needs both the model-key and the
 * team-credential permission.
 */
export function writePermissionsFor(shape: Pick<ProviderListing['shapes'][number], 'writesTo'>, scope: ProviderApiScope): ProviderWritePermission[] {
  return shape.writesTo[scope]?.permissions ?? [];
}

/**
 * Surfaces the provider serves, and each one it can't with the registry's
 * reason. The page shows only `serves`: listing what a provider does not do
 * is the copy rule `not-this-its-that` (packages/core/copy-rules.ts).
 */
export function servesLine(p: Pick<ProviderListing, 'surfaces'>): {
  serves: ProviderSurfaceId[];
  not: { surface: ProviderSurfaceId; reason: string }[];
} {
  const serves: ProviderSurfaceId[] = [];
  const not: { surface: ProviderSurfaceId; reason: string }[] = [];
  for (const s of SURFACE_ORDER) {
    const support = p.surfaces[s];
    if (!support) continue;
    if (support.ok) serves.push(s);
    else not.push({ surface: s, reason: support.reason });
  }
  return { serves, not };
}

export function surfaceList(surfaces: readonly ProviderSurfaceId[]): string {
  const parts = SURFACE_ORDER.filter((s) => surfaces.includes(s)).map((s) => SURFACE_PHRASE[s]);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Used for chat and Claude agents." */
export function usedFor(surfaces: readonly ProviderSurfaceId[]): string {
  return surfaces.length ? `Used for ${surfaceList(surfaces)}.` : 'Not used by anything.';
}

export type RowState = { word: 'Needs attention' | 'Working' | 'Set' | 'Team key' | 'Not available' | 'Not set'; tone: 'error' | 'success' | 'muted' };

/** The one status word on a provider row. */
export function rowState(rows: readonly ProviderCredentialSummary[], inherited: readonly ProviderCredentialSummary[], closed: string | null): RowState {
  if (rows.some((r) => r.health === 'revoked' || r.lastVerificationError)) return { word: 'Needs attention', tone: 'error' };
  if (rows.some((r) => r.health === 'healthy')) return { word: 'Working', tone: 'success' };
  if (rows.length > 0) return { word: 'Set', tone: 'muted' };
  if (inherited.length > 0) return { word: 'Team key', tone: 'muted' };
  if (closed) return { word: 'Not available', tone: 'muted' };
  return { word: 'Not set', tone: 'muted' };
}

/** What a stored credential looks like on the row: "…a1b2", "Subscription …bAAA", "Configured". */
export function maskedValue(row: Pick<ProviderCredentialSummary, 'shape' | 'last4'>): string {
  const tail = row.last4 ? `…${row.last4}` : '';
  if (row.shape === 'setup_token' || row.shape === 'oauth_managed') return tail ? `Subscription ${tail}` : 'Subscription';
  if (row.shape === 'gateway' || row.shape === 'endpoint') return 'Configured';
  return tail || 'Set';
}

/** True when the team accepts personal credentials anywhere (chat or agent runs). */
export function personalAccepted(policy: ProviderPolicySummary): boolean {
  return policy.chat.policy !== 'team' || policy.agent.policy !== 'team';
}

export type CardEdit =
  /** Paste a value for this shape (set / replace / remove). */
  | { kind: 'paste'; shape: ProviderShapeId }
  /** Set up with the form under Advanced. */
  | { kind: 'form' }
  | { kind: 'none' };

export interface CardView {
  /** Rows stored at this scope. */
  rows: ProviderCredentialSummary[];
  /** Workspace tab with no override: the team rows it falls back to. */
  inherited: ProviderCredentialSummary[];
  /** The scope is closed to this provider: the registry's reason. */
  closed: string | null;
  /** What the caller can do here. */
  edit: CardEdit;
  /** Shown when the caller can see but not change this scope. */
  readOnly: string | null;
  /** A connect-in-browser shape exists (subscription seats). */
  connectInBrowser: boolean;
}

export function cardView(p: ProviderListing, scope: ProviderApiScope, res: Pick<ListProvidersResponse, 'caller' | 'policy'>): CardView {
  const rows = (scope === 'team' ? p.set.team : scope === 'workspace' ? p.set.workspace : p.set.mine) ?? [];
  const inherited = scope === 'workspace' && rows.length === 0 ? p.set.team : [];
  const scopeState = p.scopes[scope];
  const closed = scopeState && !scopeState.ok ? scopeState.reason : null;
  const connectInBrowser = p.shapes.some((s) => s.connectInBrowser);
  const base = { rows, inherited, connectInBrowser };
  if (closed) return { ...base, closed, edit: { kind: 'none' }, readOnly: null };

  const pasteShape = p.shapes.find((s) => !s.connectInBrowser && (s.id === 'api_key' || s.id === 'setup_token') && s.writesTo[scope]);
  const formShape = p.shapes.find((s) => s.id === 'gateway' || s.id === 'endpoint');
  const edit: CardEdit = pasteShape ? { kind: 'paste', shape: pasteShape.id } : formShape ? { kind: 'form' } : { kind: 'none' };
  if (edit.kind === 'none') return { ...base, closed: null, edit, readOnly: null };

  if (scope === 'mine') {
    if (!res.caller.canSetMine) return { ...base, closed: null, edit: { kind: 'none' }, readOnly: MINE_NEEDS_PERSON };
    if (!personalAccepted(res.policy)) return { ...base, closed: null, edit: { kind: 'none' }, readOnly: POLICY_BLOCKS_MINE };
    return { ...base, closed: null, edit, readOnly: null };
  }
  const shape = pasteShape ?? formShape!;
  if (!writePermissionsFor(shape, scope).every((perm) => res.caller.can[perm])) return { ...base, closed: null, edit: { kind: 'none' }, readOnly: ADMINS_ONLY };
  return { ...base, closed: null, edit, readOnly: null };
}

// ── Credential policy ────────────────────────────────────────────────────────

export const POLICY_OPTIONS: readonly { value: CredentialPolicyValue; label: string; hint: string }[] = [
  { value: 'team', label: 'Team key', hint: "Everyone uses the team's key." },
  { value: 'personal_first', label: "Mine, then the team's", hint: "Uses your key when you've added one." },
  { value: 'personal_only', label: 'Mine only', hint: 'You need your own key to start work.' },
];

/**
 * The policy in effect. Unset behaves as team keys only, so the page shows
 * Team key as chosen rather than a prompt to pick (copy rule
 * `warning-instead-of-default`).
 */
export function effectivePolicy(policy: Pick<ProviderPolicySummary, 'credentialPolicy'>): CredentialPolicyValue {
  return policy.credentialPolicy ?? 'team';
}

/** One line for whoever can't change the policy: "Who pays: Team key. Everyone uses the team's key." */
export function policySentence(policy: Pick<ProviderPolicySummary, 'credentialPolicy'>): string {
  const opt = POLICY_OPTIONS.find((o) => o.value === effectivePolicy(policy))!;
  return `${opt.label}. ${opt.hint}`;
}

export function isScopeTab(v: string | null): v is ProviderApiScope {
  return v === 'team' || v === 'workspace' || v === 'mine';
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/**
 * Providers that are one thing to the reader: a Claude key and a Claude
 * subscription are both "Claude". One row, one input; what was pasted decides
 * where it's stored (`detectPaste`).
 */
export const PROVIDER_GROUPS: readonly { id: string; label: string; members: readonly string[] }[] = [
  { id: 'claude', label: 'Claude', members: ['anthropic', 'claude-subscription'] },
  { id: 'openai', label: 'OpenAI', members: ['openai', 'codex-subscription'] },
];

export interface ProviderGroup { id: string; label: string; members: ProviderListing[] }

/** Registry order, grouped providers collapsed onto their first member's place. */
export function groupProviders(providers: readonly ProviderListing[]): ProviderGroup[] {
  const out: ProviderGroup[] = [];
  const placed = new Set<string>();
  for (const p of providers) {
    if (placed.has(p.id)) continue;
    const g = PROVIDER_GROUPS.find((x) => x.members.includes(p.id));
    const members = g ? providers.filter((q) => g.members.includes(q.id)) : [p];
    for (const m of members) placed.add(m.id);
    out.push({ id: g?.id ?? p.id, label: g?.label ?? p.label, members });
  }
  return out;
}

/** The provider and shape a pasted value belongs to, read from its format. */
export function detectPaste(groupId: string, value: string): { provider: string; shape: ProviderShapeId } | { error: string } {
  const v = value.trim();
  if (groupId === 'claude') {
    if (/^sk-ant-oat/.test(v)) return { provider: 'claude-subscription', shape: 'setup_token' };
    if (/^sk-ant-/.test(v)) return { provider: 'anthropic', shape: 'api_key' };
    return { error: 'Paste a Claude API key (sk-ant-api…) or setup token (sk-ant-oat…).' };
  }
  if (groupId === 'openai') {
    if (/^sk-/.test(v)) return { provider: 'openai', shape: 'api_key' };
    return { error: 'Paste an OpenAI API key (sk-…).' };
  }
  return { error: 'Unknown provider.' };
}
