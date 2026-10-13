/**
 * What the Models and Keys pages show for one provider at one scope, derived
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

/** The LiteLLM gateway and custom endpoint forms: the Routing section further down this page. */

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

export type RowState = { word: 'Needs attention' | 'Working' | 'Set' | 'Team key' | 'Not set up'; tone: 'error' | 'success' | 'muted' };

/** The one status word on a provider row. */
export function rowState(rows: readonly ProviderCredentialSummary[], inherited: readonly ProviderCredentialSummary[], closed: string | null): RowState {
  if (rows.some((r) => r.health === 'revoked' || r.lastVerificationError)) return { word: 'Needs attention', tone: 'error' };
  if (rows.some((r) => r.health === 'healthy')) return { word: 'Working', tone: 'success' };
  if (rows.length > 0) return { word: 'Set', tone: 'muted' };
  if (inherited.length > 0) return { word: 'Team key', tone: 'muted' };
  if (closed) return { word: 'Not set up', tone: 'muted' };
  return { word: 'Not set up', tone: 'muted' };
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

// ── Whose key ────────────────────────────────────────────────────────────────

/** The one rule, for chat and agent runs alike. There is no setting for it. */
export const KEY_RULE = "Your key goes first. The team's key is the fallback.";

const STORED_POLICY_LABEL: Partial<Record<CredentialPolicyValue, string>> = {
  team: 'team keys only',
  personal_only: 'personal keys only',
};

/**
 * A team that stored a policy other than the default (before the setting was
 * removed) gets one line saying so, e.g. "This team uses team keys only.".
 * Null for every other team: the rule needs no line on Models.
 */
export function storedPolicyLine(policy: Pick<ProviderPolicySummary, 'credentialPolicy'>): string | null {
  const label = policy.credentialPolicy ? STORED_POLICY_LABEL[policy.credentialPolicy] : undefined;
  return label ? `This team uses ${label}.` : null;
}

/** The line on You › Keys: the stored exception if there is one, else the rule. */
export function keyRuleLine(policy: Pick<ProviderPolicySummary, 'credentialPolicy'>): string {
  return storedPolicyLine(policy) ?? KEY_RULE;
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





// ── Used for ─────────────────────────────────────────────────────────────────

/** Providers the team has connected (a team row exists), in registry order. */
export function connectedProviders(res: Pick<ListProvidersResponse, 'providers'>): ProviderListing[] {
  return res.providers.filter((p) => (p.set.team ?? []).length > 0);
}

export interface UsedForOption { value: string; label: string; disabled: boolean; description?: string }
export interface UsedForRow { surface: ProviderSurfaceId; label: string; value: string | null; options: UsedForOption[] }

/** "Automatic": the team made no pick for this surface; the resolver's own order decides. */
export const AUTOMATIC = '';

/**
 * One connected provider: no rows (it serves what it can, and `loneProviderLine`
 * says so). Two or more: one row per surface, every connected provider an
 * option, the ones a surface cannot use disabled with the registry's reason.
 */
export function usedForView(
  res: Pick<ListProvidersResponse, 'providers'>,
  assignments: Partial<Record<ProviderSurfaceId, string>>,
): UsedForRow[] | null {
  const connected = connectedProviders(res);
  if (connected.length < 2) return null;
  // A group shows once per surface, named the way the list names its row
  // ("Claude"): only its members that serve the surface, or the first one,
  // disabled, when none does. Two members serving go by their own names.
  const groupOf = (id: string) => PROVIDER_GROUPS.find((g) => g.members.includes(id));
  return SURFACE_ORDER.map((surface) => {
    const serves = (p: ProviderListing) => !!p.surfaces[surface]?.ok;
    const shown = connected.filter((p) => {
      const g = groupOf(p.id);
      if (!g) return true;
      const members = connected.filter((q) => groupOf(q.id) === g);
      return members.some(serves) ? serves(p) : members[0] === p;
    });
    const label = (p: ProviderListing) => {
      const g = groupOf(p.id);
      return g && shown.filter((q) => groupOf(q.id) === g).length < 2 ? g.label : p.label;
    };
    const options: UsedForOption[] = shown.map((p) => {
      const support = p.surfaces[surface];
      if (support?.ok) {
        // Every team key rejected: picking it would route this surface to a key that fails.
        const broken = (p.set.team ?? []).every((r) => r.health === 'revoked' || !!r.lastVerificationError);
        return broken
          ? { value: p.id, label: label(p), disabled: true, description: 'Needs a working key' }
          : { value: p.id, label: label(p), disabled: false };
      }
      // The limit as a fact where someone acts ("Needs OpenAI or OpenRouter"), not a list of what it can't do.
      const instead = support?.instead?.map((id) => res.providers.find((q) => q.id === id)?.label ?? id) ?? [];
      return { value: p.id, label: label(p), disabled: true, description: instead.length ? `Needs ${orList(instead)}` : support?.reason };
    });
    const picked = assignments[surface];
    const value = picked && options.some((o) => o.value === picked && !o.disabled) ? picked : null;
    return { surface, label: SURFACE_LABEL[surface], value, options };
  });
}

/** With one connected provider: "OpenRouter is used for chat, Claude agents and cloud agents." */
export function loneProviderLine(res: Pick<ListProvidersResponse, 'providers'>): string | null {
  const connected = connectedProviders(res);
  if (connected.length !== 1) return null;
  const p = connected[0];
  const { serves } = servesLine(p);
  return serves.length ? `${p.label} is used for ${surfaceList(serves)}.` : null;
}

function orList(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] ?? '';
}
