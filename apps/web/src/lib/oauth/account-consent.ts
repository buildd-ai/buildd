/**
 * Consent for an account-level MCP connection (docs/specs/auth-oauth-boundaries.md,
 * "Account-level consent").
 *
 * The authorize endpoint takes this path when the client asks for the
 * account-level resource (`resource=<issuer>/api/mcp`). The person picks which
 * workspaces, across their teams, the connection may reach, what kind of
 * connection it is ('agent' by default, 'person' only when the client asked
 * for it) and whether it may write. Approving creates one grant
 * (lib/mcp-grants.ts) and a code bound to it.
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
  if (!resource) return false;
  const trim = (s: string) => s.replace(/\/+$/, '');
  return trim(resource) === trim(accountResourceUrl);
}

export interface ConsentWorkspace {
  id: string;
  name: string;
}

export interface ConsentTeam {
  id: string;
  name: string;
  /** The user's role on the team now. */
  role: string | null;
  /** Every workspace of the team, sorted by name. */
  workspaces: ConsentWorkspace[];
}

export interface ConsentState {
  /** Selected workspace ids, each one the user can reach. */
  selected: string[];
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
  return ws.name.toLowerCase().includes(q) || team.name.toLowerCase().includes(q);
}

export function filteredWorkspaces(team: ConsentTeam, query: string): ConsentWorkspace[] {
  return team.workspaces.filter((w) => matches(query, team, w));
}

/**
 * The first visit. Exactly one workspace is preselected: the one the client
 * named, if the user can reach it, else the first workspace of the first
 * team. The kind is 'person' only when the client asked for it; otherwise it
 * is 'agent'. Write is on when the client asked for it.
 */
export function initialConsentState(
  teams: ConsentTeam[],
  requested: RequestedAccess,
  hintWorkspaceId: string | null,
): ConsentState {
  const reachable = allWorkspaceIds(teams);
  const first = teams.find((t) => t.workspaces.length > 0)?.workspaces[0]?.id ?? null;
  const pick = hintWorkspaceId && reachable.has(hintWorkspaceId) ? hintWorkspaceId : first;
  const pages: Record<string, number> = {};
  if (pick) {
    const team = teams.find((t) => t.workspaces.some((w) => w.id === pick));
    if (team) {
      const index = team.workspaces.findIndex((w) => w.id === pick);
      const page = Math.floor(index / CONSENT_PAGE_SIZE) + 1;
      if (page > 1) pages[team.id] = page;
    }
  }
  return {
    selected: pick ? [pick] : [],
    actsAs: requested.person ? 'person' : 'agent',
    write: requested.write,
    query: '',
    pages,
    focusTeam: null,
  };
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
  const next: ConsentState = { ...state, pages: { ...state.pages }, focusTeam: team?.id ?? null };

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

  if (ids.length === 0) {
    return { ok: false, status: 400, message: 'Choose at least one workspace.', showPage: true };
  }
  return { ok: true, workspaceIds: ids, actsAs: kind, scopes: write === 'on' ? ['read', 'write'] : ['read'] };
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
 */
export const CONSENT_CSS = `
:root {
  --surface-1: #1a1816; --card: #221f1c; --inset: #26221e; --q-tint: rgba(255,245,230,0.06);
  --text-primary: #ede8e2; --text-muted: #a89f96; --on-ink: #1a1816;
  --border: rgba(255,245,230,0.10); --line-soft: rgba(255,245,230,0.07); --border-strong: rgba(255,245,230,0.22);
  --accent: #f4811f; --dec-frame: #f4811f; --status-error: #e08a7f;
  --font-sans: "Schibsted Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-voice: Newsreader, Georgia, "Times New Roman", serif;
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
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface-1); color: var(--text-primary); font-family: var(--font-sans); font-size: var(--type-body); line-height: 1.5; }
.wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-family: var(--font-voice); font-weight: 500; font-size: var(--type-heading); line-height: 1.25; margin: 0 0 6px; }
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
.team-name { font-size: var(--type-title); font-weight: 600; flex: 1; min-width: 0; overflow-wrap: anywhere; }
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
`;

export interface ConsentPageArgs {
  clientName: string;
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
}

function hiddenInput(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function navButton(value: string, label: string, cls = 'btn', ariaLabel?: string): string {
  const aria = ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : '';
  return `<button class="${cls}" type="submit" name="nav" value="${escapeHtml(value)}"${aria}>${escapeHtml(label)}</button>`;
}

function renderTeam(team: ConsentTeam, state: ConsentState, selected: Set<string>, carried: string[]): string {
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
  const rows = visible.map((w) => `<label class="ws"><input type="checkbox" name="ws" value="${escapeHtml(w.id)}"${selected.has(w.id) ? ' checked' : ''}><span>${escapeHtml(w.name)}</span></label>`).join('\n');

  const pager = totalPages > 1
    ? `<div class="pager">${page > 1 ? navButton(`page:${team.id}:${page - 1}`, 'Previous', 'btn', `Previous page of ${team.name}`) : ''}<span class="meta mono">page ${page} of ${totalPages}</span>${page < totalPages ? navButton(`page:${team.id}:${page + 1}`, 'Next', 'btn', `Next page of ${team.name}`) : ''}</div>${hiddenInput('tpage', `${team.id}:${page}`)}`
    : '';

  const count = shown.length === team.workspaces.length
    ? plural(team.workspaces.length, 'workspace', 'workspaces')
    : `${shown.length} of ${team.workspaces.length}`;

  return `<details class="team" data-team="${escapeHtml(team.id)}"${open ? ' open' : ''}>
<summary><span class="team-name">${escapeHtml(team.name)}</span><span class="chip">${escapeHtml(count)}</span><span class="chip">${escapeHtml(accessLabel(team.role).toLowerCase())}</span></summary>
<div class="team-body">
${rows}
<div class="team-actions">${navButton(`team_all:${team.id}`, 'Select all in team', 'btn btn-quiet', `Select all in ${team.name}`)}${navButton(`team_clear:${team.id}`, 'Clear team', 'btn btn-quiet', `Clear ${team.name}`)}</div>
${pager}
</div>
</details>`;
}

/**
 * The consent page. A plain HTML form POSTing back to the authorize endpoint;
 * nothing is granted until the person presses Approve. Every value is escaped;
 * there is no script.
 */
export function renderAccountConsentPage(args: ConsentPageArgs): string {
  const { state, requested, teams } = args;
  const selected = new Set(state.selected);
  const safeClient = escapeHtml(args.clientName);
  const carried: string[] = [];
  const teamBlocks = teams.map((t) => renderTeam(t, state, selected, carried)).filter(Boolean);
  const totalWorkspaces = teams.reduce((n, t) => n + t.workspaces.length, 0);

  const hidden = args.hidden
    .filter(([, v]) => v !== null)
    .map(([k, v]) => hiddenInput(k, v as string))
    .join('\n');
  const carriedInputs = carried.map((id) => hiddenInput('ws', id)).join('\n');

  const personOption = requested.person
    ? `<label class="option"><input type="radio" id="kind-person" name="acts_as" value="person"${state.actsAs === 'person' ? ' checked' : ''}><span><span class="t">Acts as you</span><span class="d" style="display:block">For your own coding sessions. It can take the actions only a person may: force a review, override a landing, abandon work.</span></span></label>`
    : `<label class="option off"><input type="radio" id="kind-person" name="acts_as" value="person" disabled><span><span class="t">Acts as you</span><span class="d" style="display:block">This app did not ask to act as you.</span></span></label>`;

  const writeOption = requested.write
    ? `<label class="option"><input type="checkbox" id="perm-write" name="perm_write" value="on"${state.write ? ' checked' : ''}><span><span class="t">Write</span><span class="d" style="display:block">Create and update tasks, claim work, open pull requests, record progress and knowledge.</span></span></label>`
    : `<div class="option off"><input type="checkbox" disabled aria-label="Write, not requested"><span><span class="t">Write</span><span class="d" style="display:block">Not requested by this app.</span></span></div>`;

  const searchActive = state.query.trim() !== '';
  const workspaceList = teamBlocks.length > 0
    ? teamBlocks.join('\n')
    : `<p class="empty">${searchActive ? 'No workspaces match.' : 'No workspaces.'}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connect ${safeClient} to buildd</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CONSENT_CSS}</style>
</head>
<body>
<main class="wrap">
<h1>Connect ${safeClient} to buildd?</h1>
<p class="lede">Choose the workspaces it can reach and how it acts in them.</p>
${args.error ? `<div class="notice-err" role="alert">${escapeHtml(args.error)}</div>` : ''}
<form method="post" action="${escapeHtml(args.action ?? '/api/oauth/authorize')}" style="--carried: ${carried.length}" data-consent="account">
${hidden}
${carriedInputs}
<fieldset>
<legend>Workspaces</legend>
<div class="search"><input type="search" name="q" value="${escapeHtml(state.query)}" placeholder="Search ${escapeHtml(plural(totalWorkspaces, 'workspace', 'workspaces'))}" aria-label="Search workspaces" maxlength="${MAX_QUERY}">${navButton('search', 'Search')}</div>
<div class="bulk">${navButton('select_all', searchActive ? 'Select all matches' : 'Select all', 'btn btn-quiet')}${navButton('clear_all', 'Clear all', 'btn btn-quiet')}</div>
${workspaceList}
</fieldset>
<fieldset>
<legend>Kind of connection</legend>
<label class="option"><input type="radio" id="kind-agent" name="acts_as" value="agent"${state.actsAs === 'agent' ? ' checked' : ''}><span><span class="t">Agent working for you</span><span class="d" style="display:block">For connectors and shared or remote machines. Its work is attributed to you. Actions only a person may take are refused.</span></span></label>
${personOption}
</fieldset>
<fieldset>
<legend>Permissions</legend>
<div class="option off"><input type="checkbox" checked disabled aria-label="Read, always included"><span><span class="t">Read</span><span class="d" style="display:block">See tasks, missions, artifacts, pull requests and knowledge.</span></span></div>
${writeOption}
<p class="meta">In each workspace it is also limited to your team role: admin actions only where you are an owner or admin.</p>
</fieldset>
<div class="decision">
<dl>
<dt>Reaches</dt><dd><span class="count mono"></span> of ${escapeHtml(plural(totalWorkspaces, 'workspace', 'workspaces'))}, only while you are on their team</dd>
<dt>Acts</dt><dd><span class="k-agent">as your agent</span><span class="k-person">as you</span></dd>
<dt>Can</dt><dd><span class="p-read">read</span><span class="p-write">read and write</span></dd>
<dt>Returns to</dt><dd class="mono">${escapeHtml(args.redirectHost)}</dd>
</dl>
<div class="actions">
<button class="btn" type="submit" name="decision" value="deny">Cancel</button>
<button class="btn btn-ink" type="submit" name="decision" value="approve">Approve</button>
</div>
</div>
</form>
</main>
</body>
</html>`;
}

/** After approval, before the code redirect: what was granted, then back to the client. */
export function renderGrantInterstitial(args: { clientName: string; redirectUrl: string; workspaceCount: number; actsAs: McpGrantActsAs }): string {
  const safeClient = escapeHtml(args.clientName);
  const safeUrl = escapeHtml(args.redirectUrl);
  const reach = escapeHtml(plural(args.workspaceCount, 'workspace', 'workspaces'));
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
