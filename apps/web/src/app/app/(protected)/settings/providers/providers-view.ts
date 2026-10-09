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
  ExplainProviderResponse,
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
  'agent-claude': 'Claude runs',
  'agent-codex': 'Codex runs',
  'cloud-egress': 'Cloud runs',
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

/** Where subscription seats are connected in the browser today: Runner sign-ins, on this page. */
export const SEAT_CONNECT_HREF = '/app/settings/models#sign-ins';
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

/** Surfaces the provider serves, and each one it can't with the registry's reason. */
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
  return SURFACE_ORDER.filter((s) => surfaces.includes(s)).map((s, i) => (i === 0 ? SURFACE_LABEL[s] : SURFACE_LABEL[s].toLowerCase())).join(' · ');
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
  { value: 'team', label: 'Team key only', hint: 'Every run and chat uses team keys.' },
  { value: 'personal_first', label: "Your key first, then the team's", hint: 'Work you start uses your own key when you have one.' },
  { value: 'personal_only', label: 'Your key only (no team key)', hint: 'Work you start needs your own key.' },
];

export const POLICY_UNSET = 'No policy chosen: agents use team keys.';
export const POLICY_UNSET_HINT = 'Pick one to apply it to agent runs.';

/** One sentence for whoever can't change the policy. */
export function policySentence(policy: Pick<ProviderPolicySummary, 'credentialPolicy'>): string {
  if (!policy.credentialPolicy) return POLICY_UNSET;
  const opt = POLICY_OPTIONS.find((o) => o.value === policy.credentialPolicy);
  return opt ? `Agent runs and chat: ${opt.label.charAt(0).toLowerCase()}${opt.label.slice(1)}.` : POLICY_UNSET;
}

// ── Explain ──────────────────────────────────────────────────────────────────

const SOURCE_WORD: Record<string, string> = {
  personal: 'your key',
  mine: 'your key',
  workspace: 'workspace key',
  account: 'account key',
  team: 'team key',
  env: "buildd's key",
};

/** "Claude runs use the Anthropic API key (team key)." or the resolver's reason. */
export function explainLine(
  r: Pick<ExplainProviderResponse, 'surface' | 'result'>,
  labelOf: (provider: string) => string,
): string {
  const surface = SURFACE_LABEL[r.surface] ?? r.surface;
  if (!r.result.resolved) return `${surface}: ${r.result.reason}`;
  const whose = SOURCE_WORD[r.result.source.scope] ?? SOURCE_WORD[r.result.scope] ?? r.result.scope;
  const noun = SHAPE_NOUN[r.result.shape] ?? r.result.shape;
  // "API key" keeps its capitals; "Setup token" reads as "setup token".
  const nounInLine = noun.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
  return `${surface} ${r.surface === 'chat' ? 'uses' : 'use'} ${labelOf(r.result.provider)}: ${nounInLine}, ${whose}.`;
}

/** Explain as the caller on Mine, as team work elsewhere. */
export function explainAs(scope: ProviderApiScope, canSetMine: boolean): 'self' | 'team' {
  return scope === 'mine' && canSetMine ? 'self' : 'team';
}

export function explainUrl(o: { teamId: string; provider: string; surface: ProviderSurfaceId; workspaceId: string | null; as: 'self' | 'team' }): string {
  const qs = new URLSearchParams({ teamId: o.teamId, provider: o.provider, surface: o.surface, as: o.as });
  if (o.workspaceId) qs.set('workspaceId', o.workspaceId);
  return `/api/providers/explain?${qs}`;
}

export function isScopeTab(v: string | null): v is ProviderApiScope {
  return v === 'team' || v === 'workspace' || v === 'mine';
}
