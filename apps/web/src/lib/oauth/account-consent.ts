/**
 * Consent for an account-level MCP connection (docs/specs/auth-oauth-boundaries.md,
 * "Account-level consent").
 *
 * The authorize endpoint takes this path when the client asks for the
 * account-level resource (`resource=<issuer>/api/mcp`). The person picks, team
 * by team, what the connection may reach: no access, all current and future
 * workspaces of the team (the default for a team they choose), or specific
 * workspaces. They also pick what kind of connection it is ('agent' by
 * default, 'person' only when the client asked for it) and whether it may
 * write. Approving creates one grant (lib/mcp-grants.ts) and a code bound to
 * it.
 *
 * Everything here is pure: no database, no session. The route supplies the
 * user's teams and workspaces, re-validates the submitted selection against
 * them, and creates the grant. The page is server-rendered HTML with no
 * script: search, pagination and select all are POST round trips that carry
 * the selection, so the page works without JavaScript and under a strict CSP.
 */
import type { McpGrantActsAs, McpGrantScope } from '@buildd/core/db/schema';
import { levelForTeamRole } from './session-level';

/** A client asks for a connection that acts as the person with this scope. */
export const ACT_AS_PERSON_SCOPE = 'buildd:act-as-person';
export const READ_SCOPE = 'buildd:read';
export const WRITE_SCOPE = 'buildd:write';
/**
 * Advertised in metadata. `buildd:act-as-person` is deliberately not: a
 * generic client that requests every advertised scope would otherwise ask to
 * act as the person by default. A client that needs it names it.
 */
export const ACCOUNT_SCOPES_SUPPORTED = ['mcp', READ_SCOPE, WRITE_SCOPE] as const;

/** Workspaces per team per page. */
export const CONSENT_PAGE_SIZE = 20;

export interface RequestedAccess {
  /** The client asked to write. Read is always part of a grant. */
  write: boolean;
  /** The client asked for a connection that acts as the person. */
  person: boolean;
}

/**
 * What the client asked for. `mcp` (what clients send today) and
 * `buildd:write` ask for read and write; `buildd:read` alone asks for read
 * only. A request naming neither asks for read and write, as before. Unknown
 * scopes are ignored and never granted.
 */
export function parseRequestedAccess(scope: string | null): RequestedAccess {
  const tokens = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  const person = tokens.has(ACT_AS_PERSON_SCOPE);
  const asksWrite = tokens.has('mcp') || tokens.has(WRITE_SCOPE);
  const asksRead = tokens.has(READ_SCOPE);
  return { write: asksWrite || !asksRead, person };
}

/** The scope string recorded on the code and returned with the token. */
export function grantedScopeString(scopes: McpGrantScope[], actsAs: McpGrantActsAs): string {
  const out: string[] = [READ_SCOPE];
  if (scopes.includes('write')) out.push(WRITE_SCOPE);
  if (actsAs === 'person') out.push(ACT_AS_PERSON_SCOPE);
  return out.join(' ');
}

/** True when `resource` names the account-level MCP resource. */
export function isAccountResource(resource: string | null, accountResourceUrl: string): boolean {
  return classifyResource(resource, accountResourceUrl).kind === 'account';
}

/**
 * Which connection an authorize or token request is for (RFC 8707 `resource`).
 *
 * - `none`: no resource. New connections default to the account level.
 * - `account`: `<issuer>/api/mcp`, with or without a trailing slash or a
 *   `?workspace=` / `?repo=` connection hint (the hint narrows a call, never
 *   the grant).
 * - `legacy`: `<issuer>/api/mcp-oauth/<workspace>`, an older per-workspace
 *   address. Its token stays bound to that one workspace.
 * - `unknown`: anything else, refused with `invalid_target`.
 *
 * Only this issuer's origin counts; another host is `unknown`.
 */
export type ResourceKind =
  | { kind: 'none' }
  | { kind: 'account' }
  | { kind: 'legacy'; workspaceId: string }
  | { kind: 'unknown' };

export function classifyResource(resource: string | null, accountResourceUrl: string): ResourceKind {
  if (resource === null || resource.trim() === '') return { kind: 'none' };
  let given: URL;
  let account: URL;
  try {
    given = new URL(resource);
    account = new URL(accountResourceUrl);
  } catch {
    return { kind: 'unknown' };
  }
  if (given.origin !== account.origin || given.hash) return { kind: 'unknown' };
  const path = given.pathname.replace(/\/+$/, '');
  if (path === account.pathname.replace(/\/+$/, '')) return { kind: 'account' };
  const legacy = /^\/api\/mcp-oauth\/([^/]+)$/.exec(path);
  if (legacy && !given.search) {
    try {
      return { kind: 'legacy', workspaceId: decodeURIComponent(legacy[1]) };
    } catch {
      return { kind: 'unknown' };
    }
  }
  return { kind: 'unknown' };
}

/**
 * Apps whose name buildd can vouch for: the name is shown as verified only
 * when the redirect goes to that app's own host. Any other registration shows
 * the name it registered with, marked as unverified, next to where it returns.
 */
const KNOWN_CLIENTS: Array<{ name: string; hosts: string[] }> = [
  { name: 'buildd', hosts: ['buildd.dev'] },
  { name: 'ChatGPT', hosts: ['chatgpt.com'] },
  { name: 'Claude', hosts: ['claude.ai', 'claude.com'] },
];

export interface ClientIdentity {
  name: string;
  verified: boolean;
}

export function clientIdentity(registeredName: string, redirectUri: string): ClientIdentity {
  let host: string | null = null;
  try {
    const u = new URL(redirectUri);
    if (u.protocol === 'https:') host = u.hostname.toLowerCase();
  } catch {
    host = null;
  }
  const known = host ? KNOWN_CLIENTS.find((c) => c.hosts.includes(host as string)) : undefined;
  if (known) return { name: known.name, verified: true };
  return { name: registeredName, verified: false };
}

export interface ConsentWorkspace {
  id: string;
  name: string;
  /** `owner/repo`, when the workspace has one. */
  repo?: string | null;
  /** An internal workspace (`__` prefix, e.g. `__coordination`). */
  system?: boolean;
  /** `open` or `restricted`; the runner picker offers `restricted` to owners and admins only. */
  accessMode?: string | null;
}

export interface ConsentTeam {
  id: string;
  name: string;
  /** The user's role on the team now. */
  role: string | null;
  /** Every workspace of the team, sorted by name. */
  workspaces: ConsentWorkspace[];
}

/**
 * What a connection reaches in one team. 'all': every workspace of the team
 * now and every one created in or moved into it later (internal workspaces
 * excepted). 'specific': only the ticked workspaces.
 */
export type TeamAccessMode = 'all' | 'specific';
/** The consent page's per-team choice: a mode, or no access to the team. */
export type TeamChoice = 'none' | TeamAccessMode;
const TEAM_CHOICES: readonly TeamChoice[] = ['none', 'all', 'specific'];
const isTeamChoice = (v: unknown): v is TeamChoice => typeof v === 'string' && (TEAM_CHOICES as readonly string[]).includes(v);
/** Form field carrying a team's choice: `tmode.<teamId>`. */
export const TEAM_MODE_FIELD = 'tmode.';

export interface ConsentState {
  /** Selected workspace ids, each one the user can reach. */
  selected: string[];
  /**
   * Account consent only: what the connection reaches in each team, by team
   * id. A team that is absent gets no access. The runner picker never sets it.
   */
  teamModes?: Record<string, TeamChoice>;
  actsAs: McpGrantActsAs;
  write: boolean;
  query: string;
  /** 1-based page per team id; absent = the first page. */
  pages: Record<string, number>;
  /** The team the last action was about, kept open. */
  focusTeam: string | null;
}

function allWorkspaceIds(teams: ConsentTeam[]): Set<string> {
  return new Set(teams.flatMap((t) => t.workspaces.map((w) => w.id)));
}

function matches(query: string, team: ConsentTeam, ws: ConsentWorkspace): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return ws.name.toLowerCase().includes(q)
    || team.name.toLowerCase().includes(q)
    || (ws.repo ?? '').toLowerCase().includes(q);
}

/**
 * The teams and workspaces the consent picker offers. Internal workspaces
 * (`system`) are left out, except the one the client named with `workspace=`
 * where the person is an owner or admin of its team: that is explicitly scoped
 * admin access, so it stays choosable. Teams left with nothing are dropped.
 *
 * The route applies this on render and again on submit (the hint is part of
 * the signed authorize parameters), so an internal workspace that was not
 * offered is refused like any other unreachable one.
 */
export function pickerTeams(teams: ConsentTeam[], hintWorkspaceId: string | null): ConsentTeam[] {
  return teams
    .map((t) => ({
      ...t,
      workspaces: t.workspaces.filter((w) => !w.system
        || (w.id === hintWorkspaceId && levelForTeamRole(t.role) === 'admin')),
    }))
    .filter((t) => t.workspaces.length > 0);
}

/**
 * The second line under a workspace: its repo, and a short id only when the
 * name and repo together still do not tell it apart from a sibling.
 */
export function workspaceDetail(team: ConsentTeam, ws: ConsentWorkspace): string | null {
  const key = (w: ConsentWorkspace) => `${w.name.toLowerCase()}\u0000${(w.repo ?? '').toLowerCase()}`;
  const clash = team.workspaces.some((w) => w.id !== ws.id && key(w) === key(ws));
  const parts: string[] = [];
  if (ws.repo) parts.push(ws.repo);
  if (clash) parts.push(`id ${ws.id.slice(0, 8)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function filteredWorkspaces(team: ConsentTeam, query: string): ConsentWorkspace[] {
  return team.workspaces.filter((w) => matches(query, team, w));
}

/**
 * The first visit of the account consent page. A team is chosen only when the
 * choice is not the page's to make up: the team of the workspace the client
 * named (if the user can reach it), or the only team there is. That team is
 * set to all current and future workspaces, with the named workspace ticked
 * in case the person switches to specific workspaces; a named internal
 * workspace is never part of "all", so its team starts on specific
 * workspaces with it ticked. With several teams and no hint nothing is
 * chosen: the person picks the teams. The kind is 'person' only when the
 * client asked for it; otherwise it is 'agent'. Write is on when the client
 * asked for it.
 */
export function initialConsentState(
  teams: ConsentTeam[],
  requested: RequestedAccess,
  hintWorkspaceId: string | null,
): ConsentState {
  const hintTeam = hintWorkspaceId ? teams.find((t) => t.workspaces.some((w) => w.id === hintWorkspaceId)) : undefined;
  const hint = hintTeam?.workspaces.find((w) => w.id === hintWorkspaceId);
  const teamModes: Record<string, TeamChoice> = {};
  const pages: Record<string, number> = {};
  const selected: string[] = [];
  if (hintTeam && hint) {
    teamModes[hintTeam.id] = hint.system ? 'specific' : 'all';
    selected.push(hint.id);
    const page = Math.floor(hintTeam.workspaces.findIndex((w) => w.id === hint.id) / CONSENT_PAGE_SIZE) + 1;
    if (page > 1) pages[hintTeam.id] = page;
  } else if (teams.length === 1) {
    teamModes[teams[0].id] = 'all';
  }
  return {
    selected,
    teamModes,
    actsAs: requested.person ? 'person' : 'agent',
    write: requested.write,
    query: '',
    pages,
    focusTeam: null,
  };
}

/** The team choices a form carries, leniently: unknown teams and values are dropped. */
function readTeamModes(form: URLSearchParams, teams: ConsentTeam[]): Record<string, TeamChoice> {
  const teamIds = new Set(teams.map((t) => t.id));
  const out: Record<string, TeamChoice> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith(TEAM_MODE_FIELD)) continue;
    const id = key.slice(TEAM_MODE_FIELD.length);
    if (teamIds.has(id) && isTeamChoice(value)) out[id] = value;
  }
  return out;
}

const MAX_QUERY = 100;

/**
 * The page state carried by a consent form post (a search, a page turn,
 * select all). Lenient: an id the user cannot reach is dropped, a kind the
 * client did not ask for falls back to 'agent', write the client did not ask
 * for is off. The approval itself is checked strictly by `validateApproval`.
 */
export function readConsentForm(form: URLSearchParams, teams: ConsentTeam[], requested: RequestedAccess): ConsentState {
  const reachable = allWorkspaceIds(teams);
  const selected = [...new Set(form.getAll('ws'))].filter((id) => reachable.has(id));
  const kind = form.get('acts_as');
  const actsAs: McpGrantActsAs = kind === 'person' && requested.person ? 'person' : 'agent';
  const teamIds = new Set(teams.map((t) => t.id));
  const pages: Record<string, number> = {};
  for (const raw of form.getAll('tpage')) {
    const [teamId, n] = raw.split(':');
    const page = Number(n);
    if (teamIds.has(teamId) && Number.isInteger(page) && page > 1) pages[teamId] = page;
  }
  return {
    selected,
    teamModes: readTeamModes(form, teams),
    actsAs,
    write: requested.write && form.get('perm_write') === 'on',
    query: (form.get('q') ?? '').slice(0, MAX_QUERY),
    pages,
    focusTeam: null,
  };
}

/** Apply one form action (the `nav` button that submitted the form). */
export function applyNav(state: ConsentState, nav: string | null, teams: ConsentTeam[]): ConsentState {
  if (!nav) return state;
  const [action, teamId, n] = nav.split(':');
  const team = teamId ? teams.find((t) => t.id === teamId) : undefined;
  const selected = new Set(state.selected);
  const next: ConsentState = { ...state, pages: { ...state.pages }, ...(state.teamModes ? { teamModes: { ...state.teamModes } } : {}), focusTeam: team?.id ?? null };

  switch (action) {
    case 'search':
      // A new search starts every team on its first page.
      next.pages = {};
      return next;
    case 'select_all':
      for (const t of teams) for (const w of filteredWorkspaces(t, state.query)) selected.add(w.id);
      return { ...next, selected: [...selected] };
    case 'clear_all':
      return { ...next, selected: [] };
    case 'team_all':
      if (!team) return state;
      for (const w of filteredWorkspaces(team, state.query)) selected.add(w.id);
      return { ...next, selected: [...selected] };
    case 'team_clear':
      if (!team) return state;
      for (const w of team.workspaces) selected.delete(w.id);
      return { ...next, selected: [...selected] };
    case 'page': {
      if (!team) return state;
      const page = Number(n);
      if (!Number.isInteger(page) || page < 1) return state;
      next.pages[team.id] = page;
      return next;
    }
    default:
      return state;
  }
}

export type ApprovalCheck =
  | { ok: true; workspaceIds: string[]; actsAs: McpGrantActsAs; scopes: McpGrantScope[] }
  | { ok: false; status: 400 | 403; message: string; showPage: boolean };

/**
 * Strict check of an approval against what the user can reach now and what
 * the client asked for. A workspace the user cannot reach, a kind the client
 * did not ask for, or write the client did not ask for refuses the whole
 * approval; nothing is dropped silently, and no refusal names an id.
 */
export function validateApproval(form: URLSearchParams, teams: ConsentTeam[], requested: RequestedAccess): ApprovalCheck {
  const basics = checkApprovalBasics(form, teams, requested);
  if (!basics.ok) return basics;
  if (basics.workspaceIds.length === 0) {
    return { ok: false, status: 400, message: 'Choose at least one workspace.', showPage: true };
  }
  return basics;
}

type Refusal = { ok: false; status: 400 | 403; message: string; showPage: boolean };

/** The checks every approval shares: reachable ids, the kind, write. */
function checkApprovalBasics(form: URLSearchParams, teams: ConsentTeam[], requested: RequestedAccess): { ok: true; workspaceIds: string[]; actsAs: McpGrantActsAs; scopes: McpGrantScope[] } | Refusal {
  const reachable = allWorkspaceIds(teams);
  const ids = [...new Set(form.getAll('ws'))];
  if (ids.some((id) => !reachable.has(id))) {
    return { ok: false, status: 403, message: 'One of the chosen workspaces is not available to you. Start the connection again.', showPage: false };
  }

  const kind = form.get('acts_as') ?? 'agent';
  if (kind !== 'agent' && kind !== 'person') {
    return { ok: false, status: 400, message: 'Unknown connection kind. Start the connection again.', showPage: false };
  }
  if (kind === 'person' && !requested.person) {
    return { ok: false, status: 400, message: 'This app did not ask to act as you. Start the connection again.', showPage: false };
  }

  const write = form.get('perm_write');
  if (write !== null && write !== 'on') {
    return { ok: false, status: 400, message: 'Unknown permission. Start the connection again.', showPage: false };
  }
  if (write === 'on' && !requested.write) {
    return { ok: false, status: 400, message: 'This app did not ask to write. Start the connection again.', showPage: false };
  }

  return { ok: true, workspaceIds: ids, actsAs: kind, scopes: write === 'on' ? ['read', 'write'] : ['read'] };
}

export type AccountApprovalCheck =
  | { ok: true; teamIds: string[]; workspaceIds: string[]; actsAs: McpGrantActsAs; scopes: McpGrantScope[] }
  | Refusal;

/**
 * Strict check of an account consent approval. On top of the shared checks:
 * every team choice must name one of the offered teams (403 otherwise, a
 * tampered or stale team id) with a known value, at most once. A team on all
 * current and future workspaces becomes a whole-team grant; a team on
 * specific workspaces contributes exactly its ticked workspaces and must have
 * at least one. Ticks in a team that is not on specific workspaces are not
 * part of the approval: the page hides them, and the mode is what the person
 * chose. No refusal names an id.
 */
export function validateAccountApproval(form: URLSearchParams, teams: ConsentTeam[], requested: RequestedAccess): AccountApprovalCheck {
  const basics = checkApprovalBasics(form, teams, requested);
  if (!basics.ok) return basics;

  const byId = new Map(teams.map((t) => [t.id, t]));
  const modes = new Map<string, TeamChoice>();
  for (const key of new Set([...form.keys()].filter((k) => k.startsWith(TEAM_MODE_FIELD)))) {
    const id = key.slice(TEAM_MODE_FIELD.length);
    if (!byId.has(id)) {
      return { ok: false, status: 403, message: 'One of the chosen teams is not available to you. Start the connection again.', showPage: false };
    }
    const values = form.getAll(key);
    if (values.length !== 1 || !isTeamChoice(values[0])) {
      return { ok: false, status: 400, message: 'Unknown team access. Start the connection again.', showPage: false };
    }
    modes.set(id, values[0]);
  }

  const ticked = new Set(basics.workspaceIds);
  const teamIds: string[] = [];
  const workspaceIds: string[] = [];
  for (const team of teams) {
    const mode = modes.get(team.id) ?? 'none';
    if (mode === 'all') teamIds.push(team.id);
    if (mode !== 'specific') continue;
    const chosen = team.workspaces.filter((w) => ticked.has(w.id)).map((w) => w.id);
    if (chosen.length === 0) {
      return { ok: false, status: 400, message: `Tick at least one workspace in ${team.name}, or choose all current and future workspaces.`, showPage: true };
    }
    workspaceIds.push(...chosen);
  }
  if (teamIds.length === 0 && workspaceIds.length === 0) {
    return { ok: false, status: 400, message: 'Choose at least one team, and whether the app reaches all of its workspaces or specific ones.', showPage: true };
  }
  return { ok: true, teamIds, workspaceIds, actsAs: basics.actsAs, scopes: basics.scopes };
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Team role → the access level an OAuth session gets there (lib/oauth/session-level.ts). */
function accessLabel(role: string | null): string {
  return levelForTeamRole(role) === 'admin' ? 'Admin access' : 'Member access';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Tokens from apps/web/src/app/globals.css (the page does not load the app's
 * stylesheet). Night by default, Day under prefers-color-scheme: light.
 * The faces are the app's own self-hosted files (public/fonts, the same ones
 * app/layout.tsx hands next/font), from this origin: no font CDN.
 */
export const CONSENT_CSS = `
@font-face { font-family: "Schibsted Grotesk"; src: url("/fonts/schibsted-grotesk-latin-wght-normal.woff2") format("woff2"); font-weight: 400 900; font-style: normal; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("/fonts/jetbrains-mono-latin-wght-normal.woff2") format("woff2"); font-weight: 100 800; font-style: normal; font-display: swap; }
@font-face { font-family: "Newsreader"; src: url("/fonts/newsreader-latin-wght-normal.woff2") format("woff2"); font-weight: 200 800; font-style: normal; font-display: swap; }
:root {
  --surface-1: #1a1816; --card: #221f1c; --inset: #26221e; --q-tint: rgba(255,245,230,0.06);
  --text-primary: #ede8e2; --text-muted: #a89f96; --on-ink: #1a1816;
  --border: rgba(255,245,230,0.10); --line-soft: rgba(255,245,230,0.07); --border-strong: rgba(255,245,230,0.22);
  --accent: #f4811f; --dec-frame: #f4811f; --status-error: #e08a7f;
  --font-sans: "Schibsted Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-voice: "Newsreader", Georgia, "Times New Roman", serif;
  --type-chip: 12px; --type-eyebrow: 13px; --type-meta: 12px; --type-body: 13px; --type-title: 14px; --type-lede: 16px; --type-heading: 20px;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root {
    --surface-1: #f7f5f0; --card: #fdfcf9; --inset: #f2efe9; --q-tint: #eeebe4;
    --text-primary: #26231f; --text-muted: #6b655c; --on-ink: #fdfcf9;
    --border: #e3ded5; --line-soft: #eae5dc; --border-strong: #cfc8bc;
    --accent: #e07a2e; --dec-frame: #c2611f; --status-error: #97391f;
    color-scheme: light;
  }
}
@media (min-width: 48rem) { :root { --type-chip: 11px; --type-lede: 15px; --type-heading: 24px; } }
@media (max-width: 390px) { .team-chips { flex-basis: 100%; margin-top: 4px; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface-1); color: var(--text-primary); font-family: var(--font-sans); font-size: var(--type-body); line-height: 1.5; }
.wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { overflow-wrap: anywhere; font-family: var(--font-voice); font-weight: 500; font-size: var(--type-heading); line-height: 1.25; margin: 0 0 6px; }
.lede { font-size: var(--type-lede); line-height: 1.45; color: var(--text-muted); margin: 0 0 24px; }
fieldset { border: 0; padding: 0; margin: 0 0 24px; min-width: 0; }
legend, .eyebrow { font-size: var(--type-eyebrow); font-weight: 600; color: var(--text-muted); padding: 0; margin: 0 0 8px; }
.option { display: flex; gap: 10px; align-items: flex-start; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); margin-bottom: 8px; cursor: pointer; }
.option:has(input:checked) { border: 1.5px solid var(--text-primary); padding: 11.5px; }
.option.off { cursor: not-allowed; }
.option input { margin: 3px 0 0; width: 16px; height: 16px; flex: none; accent-color: var(--text-primary); }
.option .t { font-size: var(--type-title); font-weight: 600; line-height: 1.35; }
.option .d, .meta { font-size: var(--type-meta); color: var(--text-muted); line-height: 1.4; margin-top: 2px; }
.mono { font-family: var(--font-mono); }
.ident { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 0 0 4px; }
.verified { font-size: var(--type-chip); color: var(--text-muted); }
.ws-text { display: flex; flex-direction: column; min-width: 0; }
.ws-sub { font-family: var(--font-mono); font-size: var(--type-meta); color: var(--text-muted); overflow-wrap: anywhere; }
.facts { margin: 0 0 16px; display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); }
.facts dt { color: var(--text-muted); font-size: var(--type-meta); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.switch { border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin: 0 0 16px; }
.switch p { margin: 0 0 6px; }
.switch .addr { display: block; font-family: var(--font-mono); font-size: 14px; padding: 8px; background: var(--inset); border-radius: 4px; overflow-wrap: anywhere; user-select: all; }
.decision.sticky { position: sticky; bottom: 0; z-index: 1; box-shadow: 0 -8px 16px var(--surface-1); }
.search { display: flex; gap: 8px; margin-bottom: 8px; }
.search input { flex: 1; min-width: 0; height: 44px; padding: 0 12px; font: inherit; font-size: 16px; color: var(--text-primary); background: var(--card); border: 1px solid var(--border-strong); border-radius: 4px; }
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 12px; font: inherit; font-size: 12px; font-weight: 600; color: var(--text-primary); background: transparent; border: 1px solid var(--border-strong); border-radius: 4px; cursor: pointer; }
.btn:hover { background: var(--q-tint); }
.btn-quiet { border-color: transparent; }
.btn-ink { background: var(--text-primary); color: var(--on-ink); border-color: var(--text-primary); }
.btn-ink:hover { background: var(--text-primary); opacity: 0.9; }
.bulk { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
details.team { border-top: 1px solid var(--border); }
details.team:last-of-type { border-bottom: 1px solid var(--border); }
details.team > summary { list-style: none; display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 8px 0; cursor: pointer; }
details.team > summary::-webkit-details-marker { display: none; }
details.team > summary::before { content: "\\25B8"; color: var(--text-muted); width: 12px; flex: none; }
details.team[open] > summary::before { content: "\\25BE"; }
.team-head { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.team-name { font-size: var(--type-title); font-weight: 600; flex: 1 1 7rem; min-width: 0; overflow-wrap: break-word; }
.team-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { font-family: var(--font-mono); font-size: var(--type-chip); line-height: 1; padding: 3px 8px; border: 1px solid var(--border-strong); border-radius: 4px; color: var(--text-muted); white-space: nowrap; }
.team-body { padding: 0 0 12px 20px; }
.ws { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 4px 0; border-bottom: 1px solid var(--line-soft); cursor: pointer; overflow-wrap: anywhere; }
.ws input { width: 16px; height: 16px; flex: none; margin: 0; accent-color: var(--text-primary); }
.ws:last-of-type { border-bottom: 0; }
.team-actions, .pager { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
.pager .meta { margin: 0 4px; }
.empty { color: var(--text-muted); padding: 12px 0; }
.notice-err { border: 1px solid var(--status-error); color: var(--status-error); border-radius: 6px; padding: 10px 12px; margin: 0 0 16px; }
.decision { border: 1.5px solid var(--dec-frame); background: var(--inset); border-radius: 6px; padding: 12px; margin-top: 8px; }
.decision dl { margin: 0 0 12px; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
.decision dt { color: var(--text-muted); font-size: var(--type-meta); }
.decision dd { margin: 0; overflow-wrap: anywhere; }
form { counter-reset: ws var(--carried, 0); }
input[name="ws"][type="checkbox"]:checked { counter-increment: ws; }
.count::before { content: counter(ws); }
.k-person, .p-write { display: none; }
form:has(#kind-person:checked) .k-person { display: inline; }
form:has(#kind-person:checked) .k-agent { display: none; }
form:has(#perm-write:checked) .p-write { display: inline; }
form:has(#perm-write:checked) .p-read { display: none; }
.actions { display: flex; gap: 8px; }
.actions .btn { flex: 1; min-height: 44px; font-size: var(--type-title); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.tmode { margin: 0 0 8px; }
.tmode .option { margin-bottom: 6px; }
.option:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.team-ws { display: none; border-top: 1px solid var(--line-soft); padding-top: 4px; }
details.team:has(.tm-specific:checked) .team-ws { display: block; }
.m-all, .m-specific { display: none; }
details.team:has(.tm-all:checked) .m-all, details.team:has(.tm-specific:checked) .m-specific { display: inline; }
details.team:has(.tm-all:checked) .m-none, details.team:has(.tm-specific:checked) .m-none { display: none; }
.chip.mode { color: var(--text-primary); }
.sum-list { list-style: none; margin: 0; padding: 0; max-height: 7.5em; overflow-y: auto; }
.sum-row { display: none; overflow-wrap: anywhere; }
.sum-row.on { display: block; }
.sum-none { color: var(--text-muted); }
`;

export interface ConsentPageArgs {
  clientName: string;
  /** buildd vouches for the name (clientIdentity). Absent = unverified. */
  clientVerified?: boolean;
  /** Where the browser returns, as a host (or scheme for a native app). */
  redirectHost: string;
  /** The authorize parameters and the consent token, carried as hidden fields. */
  hidden: Array<[string, string | null]>;
  teams: ConsentTeam[];
  state: ConsentState;
  requested: RequestedAccess;
  error?: string | null;
  /** The form's action; the authorize endpoint. */
  action?: string;
  /**
   * The runner login variant (lib/runner-consent.ts): the same picker, worded
   * for a runner, with no permission or connection-kind choice (a runner key's
   * level is capped by the person's role, not chosen here).
   */
  runner?: RunnerConsentWording;
}

export interface RunnerConsentWording {
  title: string;
  lede: string;
  /** Where the browser or the key goes next, in words (e.g. a localhost port). */
  returnsTo: string;
  approveLabel: string;
  footnote: string;
}

/** An internal workspace reads as the app names it elsewhere (displayWorkspaceName). */
function displayName(ws: ConsentWorkspace): string {
  return ws.system ? 'Organizer' : ws.name;
}

/** The app's name, and the one line that says buildd could not vouch for it. */
export function clientHeader(clientName: string, verified: boolean, redirectHost: string): string {
  const badge = verified ? 'Verified app' : 'Unverified app';
  const name = verified ? escapeHtml(clientName) : `Name supplied by the app: ${escapeHtml(clientName)}`;
  return `<div class="ident"><h1>Authorize ${escapeHtml(redirectHost)}</h1><span class="verified" data-client-verified="${verified}">${badge}</span></div><p class="meta">${name}</p>`;
}

function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function navButton(value: string, label: string, cls = 'btn', ariaLabel?: string): string {
  const aria = ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : '';
  return `<button class="${cls}" type="submit" name="nav" value="${escapeHtml(value)}"${aria}>${escapeHtml(label)}</button>`;
}

/**
 * One team's block. `teamActions` is false when the page offers a single team:
 * its Select team / Clear team would repeat Select all / Clear all above it.
 */
function renderTeam(team: ConsentTeam, state: ConsentState, selected: Set<string>, carried: string[], teamActions: boolean): string {
  const shown = filteredWorkspaces(team, state.query);
  if (shown.length === 0) {
    for (const w of team.workspaces) if (selected.has(w.id)) carried.push(w.id);
    return '';
  }
  const totalPages = Math.max(1, Math.ceil(shown.length / CONSENT_PAGE_SIZE));
  const page = Math.min(Math.max(1, state.pages[team.id] ?? 1), totalPages);
  const start = (page - 1) * CONSENT_PAGE_SIZE;
  const visible = shown.slice(start, start + CONSENT_PAGE_SIZE);
  const visibleIds = new Set(visible.map((w) => w.id));
  for (const w of team.workspaces) if (selected.has(w.id) && !visibleIds.has(w.id)) carried.push(w.id);

  const hasSelection = team.workspaces.some((w) => selected.has(w.id));
  const open = hasSelection || state.focusTeam === team.id || state.query.trim() !== '' || page > 1;
  const rows = visible.map((w) => {
    const detail = workspaceDetail(team, w);
    const sub = detail ? `<span class="ws-sub">${escapeHtml(detail)}</span>` : '';
    return `<label class="ws"><input type="checkbox" name="ws" value="${escapeHtml(w.id)}"${selected.has(w.id) ? ' checked' : ''}><span class="ws-text"><span>${escapeHtml(displayName(w))}</span>${sub}</span></label>`;
  }).join('\n');

  const pager = totalPages > 1
    ? `<div class="pager">${page > 1 ? navButton(`page:${team.id}:${page - 1}`, 'Previous', 'btn', `Previous page of ${team.name}`) : ''}<span class="meta mono">page ${page} of ${totalPages}</span>${page < totalPages ? navButton(`page:${team.id}:${page + 1}`, 'Next', 'btn', `Next page of ${team.name}`) : ''}</div>${hiddenInput('tpage', `${team.id}:${page}`)}`
    : '';

  const count = shown.length === team.workspaces.length
    ? plural(team.workspaces.length, 'workspace', 'workspaces')
    : `${shown.length} of ${team.workspaces.length}`;

  return `<details class="team" data-team="${escapeHtml(team.id)}"${open ? ' open' : ''}>
<summary><span class="team-head"><span class="team-name">${escapeHtml(team.name)}</span><span class="team-chips"><span class="chip">${escapeHtml(count)}</span><span class="chip">${escapeHtml(accessLabel(team.role).toLowerCase())}</span></span></span></summary>
<div class="team-body">
${rows}
${teamActions ? `<div class="team-actions">${navButton(`team_all:${team.id}`, 'Select team', 'btn btn-quiet', `Select all in ${team.name}`)}${navButton(`team_clear:${team.id}`, 'Clear team', 'btn btn-quiet', `Clear ${team.name}`)}</div>\n` : ''}${pager}
</div>
</details>`;
}

const MODE_CHIP: Record<TeamChoice, string> = { none: 'no access', all: 'all workspaces', specific: 'specific' };

/**
 * One team on the account consent page: its access choice (no access, all
 * current and future workspaces, specific workspaces) and, shown only while
 * specific is chosen, its workspace list. The choice is a radio group per
 * team, so choosing a team is always a separate, deliberate act from ticking
 * a workspace. `index` names the team's radios and counter (ids stay short
 * and never contain a team id).
 */
function renderAccountTeam(team: ConsentTeam, index: number, state: ConsentState, selected: Set<string>, carried: string[]): string {
  const mode = state.teamModes?.[team.id] ?? 'none';
  const shown = filteredWorkspaces(team, state.query);
  const totalPages = Math.max(1, Math.ceil(shown.length / CONSENT_PAGE_SIZE));
  const page = Math.min(Math.max(1, state.pages[team.id] ?? 1), totalPages);
  const start = (page - 1) * CONSENT_PAGE_SIZE;
  const visible = shown.slice(start, start + CONSENT_PAGE_SIZE);
  const visibleIds = new Set(visible.map((w) => w.id));
  for (const w of team.workspaces) if (selected.has(w.id) && !visibleIds.has(w.id)) carried.push(w.id);

  const name = escapeHtml(team.name);
  const ordinary = team.workspaces.filter((w) => !w.system).length;
  const open = mode !== 'none' || state.focusTeam === team.id || state.query.trim() !== '' || page > 1;
  const radio = (value: TeamChoice, title: string, detail: string) => `<label class="option"><input type="radio" class="tm-${value}" id="tm${index}-${value}" name="${TEAM_MODE_FIELD}${escapeHtml(team.id)}" value="${value}"${mode === value ? ' checked' : ''}><span><span class="t">${title}</span><span class="d" style="display:block">${detail}</span></span></label>`;

  const rows = visible.map((w) => {
    const detail = workspaceDetail(team, w);
    const sub = detail ? `<span class="ws-sub">${escapeHtml(detail)}</span>` : '';
    return `<label class="ws"><input type="checkbox" name="ws" value="${escapeHtml(w.id)}"${selected.has(w.id) ? ' checked' : ''}><span class="ws-text"><span>${escapeHtml(displayName(w))}</span>${sub}</span></label>`;
  }).join('\n');
  const list = shown.length > 0
    ? rows
    : `<p class="empty">No workspaces in ${name} match “${escapeHtml(state.query.trim())}”.</p>`;
  const pager = totalPages > 1
    ? `<div class="pager">${page > 1 ? navButton(`page:${team.id}:${page - 1}`, 'Previous', 'btn', `Previous page of ${team.name}`) : ''}<span class="meta mono">page ${page} of ${totalPages}</span>${page < totalPages ? navButton(`page:${team.id}:${page + 1}`, 'Next', 'btn', `Next page of ${team.name}`) : ''}</div>${hiddenInput('tpage', `${team.id}:${page}`)}`
    : '';
  const count = shown.length === team.workspaces.length
    ? plural(team.workspaces.length, 'workspace', 'workspaces')
    : `${shown.length} of ${team.workspaces.length}`;

  return `<details class="team" data-team="${escapeHtml(team.id)}" data-i="${index}"${open ? ' open' : ''}>
<summary><span class="team-head"><span class="team-name">${name}</span><span class="team-chips"><span class="chip">${escapeHtml(count)}</span><span class="chip">${escapeHtml(accessLabel(team.role).toLowerCase())}</span><span class="chip mode" data-mode-chip><span class="m-none">${MODE_CHIP.none}</span><span class="m-all">${MODE_CHIP.all}</span><span class="m-specific">${MODE_CHIP.specific}</span></span></span></span></summary>
<div class="team-body">
<fieldset class="tmode">
<legend class="sr-only">What ${name} access covers</legend>
${radio('none', 'No access', `Nothing in ${name}.`)}
${radio('all', 'All current and future workspaces', `The ${escapeHtml(plural(ordinary, 'workspace', 'workspaces'))} in ${name} now, and any created in or moved into it later, with the permissions below. Internal workspaces are not included.`)}
${radio('specific', 'Specific workspaces', `Only the workspaces you tick. Workspaces added to ${name} later are not included.`)}
</fieldset>
<div class="team-ws" data-team-ws>
${list}
<div class="team-actions">${navButton(`team_all:${team.id}`, 'Tick all listed', 'btn btn-quiet', `Tick every workspace listed in ${team.name}`)}${navButton(`team_clear:${team.id}`, 'Clear ticks', 'btn btn-quiet', `Clear the ticked workspaces in ${team.name}`)}</div>
${pager}
<p class="meta">Ticking every workspace listed covers the workspaces of now only.</p>
</div>
</div>
</details>`;
}

/**
 * The live summary of team choices: one row per team, shown only while that
 * team has access (per-team `:has()` rules, so it follows the radios without
 * script). A specific team's count is a CSS counter over its ticks plus the
 * ticks carried from other pages.
 */
function teamSummary(teams: ConsentTeam[], state: ConsentState, carriedByTeam: Map<string, number>): { css: string; rows: string; reset: string } {
  const css: string[] = [];
  const rows: string[] = [];
  const reset: string[] = [];
  teams.forEach((team, i) => {
    const ordinary = team.workspaces.filter((w) => !w.system).length;
    const name = escapeHtml(team.name);
    css.push(`form:has(#tm${i}-all:checked) .sum-row.s${i}.all, form:has(#tm${i}-specific:checked) .sum-row.s${i}.specific { display: block; }`);
    css.push(`details[data-i="${i}"] input[name="ws"][type="checkbox"]:checked { counter-increment: c${i}; }`);
    css.push(`.cnt${i}::before { content: counter(c${i}); }`);
    reset.push(`c${i} ${carriedByTeam.get(team.id) ?? 0}`);
    rows.push(`<li class="sum-row s${i} all" data-sum="${i}:all"><strong>${name}</strong>: all current and future workspaces, ${escapeHtml(plural(ordinary, 'workspace', 'workspaces'))} now</li>`);
    rows.push(`<li class="sum-row s${i} specific" data-sum="${i}:specific"><strong>${name}</strong>: <span class="cnt${i} mono"></span> ticked, none added later</li>`);
  });
  return { css: css.join('\n'), rows: rows.join('\n'), reset: reset.join(' ') };
}

/** A team the search hides keeps its choice and a static summary row. */
function hiddenTeamCarry(team: ConsentTeam, state: ConsentState, selected: Set<string>, carried: string[]): { inputs: string; row: string } {
  const mode = state.teamModes?.[team.id] ?? 'none';
  for (const w of team.workspaces) if (selected.has(w.id)) carried.push(w.id);
  const inputs = mode === 'none' ? '' : hiddenInput(`${TEAM_MODE_FIELD}${team.id}`, mode);
  const name = escapeHtml(team.name);
  const ordinary = team.workspaces.filter((w) => !w.system).length;
  const ticked = team.workspaces.filter((w) => selected.has(w.id)).length;
  const row = mode === 'all'
    ? `<li class="sum-row on" data-sum-static="all"><strong>${name}</strong>: all current and future workspaces, ${escapeHtml(plural(ordinary, 'workspace', 'workspaces'))} now</li>`
    : mode === 'specific'
      ? `<li class="sum-row on" data-sum-static="specific"><strong>${name}</strong>: ${ticked} ticked, none added later</li>`
      : '';
  return { inputs, row };
}

/** The account page's team blocks, the inputs carried for hidden teams, and the summary. */
function renderAccountTeams(teams: ConsentTeam[], state: ConsentState, selected: Set<string>, carried: string[]) {
  const blocks: string[] = [];
  const carriedModes: string[] = [];
  const staticRows: string[] = [];
  const carriedByTeam = new Map<string, number>();
  const shownTeams: ConsentTeam[] = [];
  const searching = state.query.trim() !== '';
  teams.forEach((team) => {
    const before = carried.length;
    // Searching hides a team whose name and workspaces all miss; its choice still rides along.
    if (searching && filteredWorkspaces(team, state.query).length === 0) {
      const c = hiddenTeamCarry(team, state, selected, carried);
      if (c.inputs) carriedModes.push(c.inputs);
      if (c.row) staticRows.push(c.row);
      return;
    }
    blocks.push(renderAccountTeam(team, shownTeams.length, state, selected, carried));
    carriedByTeam.set(team.id, carried.length - before);
    shownTeams.push(team);
  });
  const summary = teamSummary(shownTeams, state, carriedByTeam);
  const anyChosen = Object.values(state.teamModes ?? {}).some((m) => m !== 'none');
  return { blocks, carriedModes, staticRows, summary, anyChosen };
}

/**
 * The consent page. A plain HTML form POSTing back to the authorize endpoint;
 * nothing is granted until the person presses Allow access. Every value is
 * escaped; there is no script. The selection count is a CSS counter, so it
 * follows the checkboxes live without script too.
 */
export function renderAccountConsentPage(args: ConsentPageArgs): string {
  const { state, requested, teams } = args;
  const selected = new Set(state.selected);
  const safeClient = escapeHtml(args.clientName);
  const carried: string[] = [];
  const runner = args.runner ?? null;
  const account = runner ? null : renderAccountTeams(teams, state, selected, carried);
  const teamBlocks = account ? account.blocks : teams.map((t) => renderTeam(t, state, selected, carried, teams.length > 1)).filter(Boolean);
  const totalWorkspaces = teams.reduce((n, t) => n + t.workspaces.length, 0);

  const hidden = args.hidden
    .filter(([, v]) => v !== null)
    .map(([k, v]) => hiddenInput(k, v as string))
    .join('\n');
  const carriedInputs = carried.map((id) => hiddenInput('ws', id)).join('\n');

  const kind = requested.person
    ? `<fieldset>
<legend>Acts</legend>
<label class="option"><input type="radio" id="kind-agent" name="acts_as" value="agent"${state.actsAs === 'agent' ? ' checked' : ''}><span><span class="t">As your agent</span><span class="d" style="display:block">Work is attributed to you. Actions only a person may take are refused.</span></span></label>
<label class="option"><input type="radio" id="kind-person" name="acts_as" value="person"${state.actsAs === 'person' ? ' checked' : ''}><span><span class="t">As you</span><span class="d" style="display:block">For your own coding sessions. It can force a review, override a landing and abandon work.</span></span></label>
</fieldset>`
    : `<input type="hidden" name="acts_as" value="agent">`;

  const writeOption = requested.write
    ? `<label class="option"><input type="checkbox" id="perm-write" name="perm_write" value="on"${state.write ? ' checked' : ''}><span><span class="t">Write</span><span class="d" style="display:block">Create and update tasks, claim work, open pull requests, record progress and knowledge.</span></span></label>`
    : '';

  const searchActive = state.query.trim() !== '';
  const workspaceList = teamBlocks.length > 0
    ? teamBlocks.join('\n')
    : `<p class="empty" data-empty="${searchActive ? 'search' : 'none'}">${searchActive ? `No ${account ? 'teams or workspaces' : 'workspaces'} match “${escapeHtml(state.query.trim())}”.` : 'No workspaces.'}</p>`;

  const picker = account
    ? `<fieldset>
<legend>Teams</legend>
<p class="meta" style="margin:0 0 8px">For each team, choose No access, All current and future workspaces, or Specific workspaces.</p>
<div class="search"><input type="search" name="q" value="${escapeHtml(state.query)}" placeholder="Team or repo" aria-label="Search teams, workspaces and repositories" maxlength="${MAX_QUERY}">${navButton('search', 'Search')}</div>
${account.carriedModes.join('\n')}
${workspaceList}
<p class="meta">With All current and future workspaces, a workspace created in the team or moved into it later is included straight away, with the same permissions. A workspace moved out of the team, or a team you leave, is no longer reachable. You can change this in Settings, Apps signed in as you.</p>
</fieldset>`
    : `<fieldset>
<legend>Workspaces</legend>
<div class="search"><input type="search" name="q" value="${escapeHtml(state.query)}" placeholder="Name or repo" aria-label="Search workspaces, teams and repositories" maxlength="${MAX_QUERY}">${navButton('search', 'Search')}</div>
<div class="bulk">${navButton('select_all', searchActive ? 'Select all matches' : 'Select all', 'btn btn-quiet')}${navButton('clear_all', 'Clear all', 'btn btn-quiet')}</div>
${workspaceList}
<p class="meta">${runner ? escapeHtml(runner.footnote) : ''}</p>
</fieldset>`;

  const reach = account
    ? `<dt>Teams</dt><dd><ul class="sum-list" data-summary="teams">
${account.summary.rows}
${account.staticRows.join('\n')}
</ul>${account.anyChosen ? '' : '<span class="sum-none" data-sum-none>No team chosen yet.</span>'}</dd>
`
    : `<dt>Selected</dt><dd><span class="count mono"></span> of ${escapeHtml(plural(totalWorkspaces, 'workspace', 'workspaces'))}</dd>
`;
  const formStyle = account
    ? `--carried: ${carried.length}; counter-reset: ws ${carried.length}${account.summary.reset ? ` ${account.summary.reset}` : ''}`
    : `--carried: ${carried.length}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${runner ? escapeHtml(runner.title) : `Authorize ${safeClient}`}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CONSENT_CSS}${account ? `\n.sum-none { display: block; }\nform:has(.tm-all:checked, .tm-specific:checked) .sum-none { display: none; }\n${account.summary.css}` : ''}</style>
</head>
<body>
<main class="wrap">
${runner ? `<div class="ident"><h1>${escapeHtml(runner.title)}</h1></div>` : clientHeader(args.clientName, args.clientVerified === true, args.redirectHost)}
<p class="lede">${runner ? escapeHtml(runner.lede) : `Choose the teams and workspaces ${safeClient} can access.`}</p>
${args.error ? `<div class="notice-err" role="alert">${escapeHtml(args.error)}</div>` : ''}
<form method="post" action="${escapeHtml(args.action ?? '/api/oauth/authorize')}" style="${formStyle}" data-consent="${runner ? 'runner' : 'account'}">
${hidden}
${carriedInputs}
${picker}
${runner ? '' : `<fieldset>
<legend>Permissions</legend>
<div class="option off"><input type="checkbox" checked disabled aria-label="Read, always included"><span><span class="t">Read</span><span class="d" style="display:block">See tasks, missions, artifacts, pull requests and knowledge.</span></span></div>
${writeOption}
<p class="meta">Admin actions work only where you are a team owner or admin.</p>
</fieldset>
${kind}`}
<div class="decision sticky" aria-live="polite" aria-label="Summary">
<dl>
${reach}${runner ? '' : `<dt>Can</dt><dd><span class="p-read">read</span><span class="p-write">read and write</span>, <span class="k-agent">as your agent</span><span class="k-person">as you</span></dd>\n`}<dt>Returns to</dt><dd class="mono">${escapeHtml(runner ? runner.returnsTo : args.redirectHost)}</dd>
</dl>
<div class="actions">
<button class="btn" type="submit" name="decision" value="deny">Cancel</button>
<button class="btn btn-ink" type="submit" name="decision" value="approve">${runner ? escapeHtml(runner.approveLabel) : 'Allow access'}</button>
</div>
</div>
</form>
</main>
</body>
</html>`;
}

/** One team of a new grant, for the confirmation line. */
export interface GrantedTeamSummary {
  name: string;
  mode: TeamAccessMode;
  /** Workspaces reached there now. */
  count: number;
}

/** "all current and future workspaces in Alpha (12 now) and 2 workspaces in Beta" */
export function describeGrantedTeams(teams: GrantedTeamSummary[]): string {
  const parts = teams.map((t) => (t.mode === 'all'
    ? `all current and future workspaces in ${t.name} (${t.count} now)`
    : `${plural(t.count, 'workspace', 'workspaces')} in ${t.name}`));
  if (parts.length <= 1) return parts[0] ?? 'no workspace';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** After approval, before the code redirect: what was granted, then back to the client. */
export function renderGrantInterstitial(args: { clientName: string; redirectUrl: string; teams: GrantedTeamSummary[]; actsAs: McpGrantActsAs }): string {
  const safeClient = escapeHtml(args.clientName);
  const safeUrl = escapeHtml(args.redirectUrl);
  const reach = escapeHtml(describeGrantedTeams(args.teams));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connected ${safeClient}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="1;url=${safeUrl}">
<style>${CONSENT_CSS}</style>
</head>
<body>
<main class="wrap">
<h1>Connected ${safeClient}.</h1>
<p class="lede">It can reach ${reach}, ${args.actsAs === 'person' ? 'acting as you' : 'as your agent'}.</p>
<p class="meta">Returning you to the app, or <a href="${safeUrl}" style="color: var(--text-primary)">continue now</a>.</p>
</main>
</body>
</html>`;
}

// ── Older per-workspace address ──────────────────────────────────────────────
//
// A client whose connector still uses `<issuer>/api/mcp-oauth/<workspace>`
// asks for that resource. Its token can only work at that address, so the page
// offers exactly that workspace (no picker: choosing another one would mint a
// token the address refuses) and shows the one address that reaches several.
// The token stays bound to the workspace in the resource; nothing is
// redirected and nothing is widened.

export interface LegacyConsentArgs {
  clientName: string;
  clientVerified?: boolean;
  redirectHost: string;
  hidden: Array<[string, string | null]>;
  workspace: { name: string; teamName: string; repo: string | null; system?: boolean };
  /** The person's access there, from their team role. */
  level: 'admin' | 'worker';
  /** `<issuer>/api/mcp`. */
  canonicalUrl: string;
  action?: string;
}

export function renderLegacyConsentPage(args: LegacyConsentArgs): string {
  const safeClient = escapeHtml(args.clientName);
  const hidden = args.hidden
    .filter(([, v]) => v !== null)
    .map(([k, v]) => hiddenInput(k, v as string))
    .join('\n');
  const ws = args.workspace;
  const name = ws.system ? 'Organizer' : ws.name;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize ${safeClient}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CONSENT_CSS}</style>
</head>
<body>
<main class="wrap" data-consent="legacy">
${clientHeader(args.clientName, args.clientVerified === true, args.redirectHost)}
<p class="lede">${safeClient} is using an older buildd address that reaches one workspace.</p>
<dl class="facts">
<dt>Workspace</dt><dd>${escapeHtml(name)}</dd>
<dt>Team</dt><dd>${escapeHtml(ws.teamName)}</dd>
${ws.repo ? `<dt>Repository</dt><dd class="mono">${escapeHtml(ws.repo)}</dd>` : ''}
<dt>Can</dt><dd data-access-level="${args.level}">${args.level === 'admin' ? 'read and write, including admin actions' : 'read and write'}</dd>
<dt>Returns to</dt><dd class="mono">${escapeHtml(args.redirectHost)}</dd>
</dl>
<div class="switch" data-migrate="canonical">
<p>To choose several workspaces in one connection, connect ${safeClient} to this address instead:</p>
<span class="addr">${escapeHtml(args.canonicalUrl)}</span>
</div>
<form method="post" action="${escapeHtml(args.action ?? '/api/oauth/authorize')}">
${hidden}
<div class="actions">
<button class="btn" type="submit" name="decision" value="deny">Cancel</button>
<button class="btn btn-ink" type="submit" name="decision" value="approve">Allow access</button>
</div>
</form>
</main>
</body>
</html>`;
}

/** After approving the older address: which workspace, then back to the client. */
export function renderLegacyInterstitial(args: { clientName: string; redirectUrl: string; workspaceName: string }): string {
  const safeClient = escapeHtml(args.clientName);
  const safeUrl = escapeHtml(args.redirectUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connected ${safeClient}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="1;url=${safeUrl}">
<style>${CONSENT_CSS}</style>
</head>
<body>
<main class="wrap">
<h1>Connected ${safeClient}.</h1>
<p class="lede">It can reach ${escapeHtml(args.workspaceName)}.</p>
<p class="meta">Returning you to the app, or <a href="${safeUrl}" style="color: var(--text-primary)">continue now</a>.</p>
</main>
</body>
</html>`;
}
