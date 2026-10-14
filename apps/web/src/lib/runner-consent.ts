/**
 * The runner consent page (spec "One runner for every team you run", R-1,
 * R-2, R-4): `buildd login` (browser and `--device`) and Settings' Edit end on
 * the MCP sign-in picker (lib/oauth/account-consent.ts), worded for a runner.
 *
 * Three flows share it:
 *   - `cli`: GET /api/auth/cli renders it; its POST mints the key and sends
 *     the browser back to the CLI's localhost callback with the token, exactly
 *     as before, so a runner that only opens the URL keeps working.
 *   - `device`: /api/auth/device/consent?code= renders it; its POST approves
 *     the code with the picks.
 *   - `edit`: /api/auth/runner-picks?account= reopens it with a key's current
 *     picks; its POST replaces them without a new key.
 *
 * Like the MCP page: server-rendered HTML, no script; search, paging and
 * select all are POST round trips. The form carries an HMAC over the signed-in
 * person and every flow parameter, and must be posted from this origin.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { getIssuer, getJwtSecret } from './oauth/config';
import {
  CONSENT_CSS,
  escapeHtml,
  applyNav,
  readConsentForm,
  renderAccountConsentPage,
  validateApproval,
  type ConsentState,
  type ConsentTeam,
  type RequestedAccess,
  type RunnerConsentWording,
} from './oauth/account-consent';

export type RunnerConsentFlow =
  | { kind: 'cli'; callback: string; client: string | null; accountName: string | null; level: string | null; machine: string | null }
  | { kind: 'device'; code: string }
  | { kind: 'edit'; accountId: string; accountName: string };

/** A runner page never offers write or act-as-person: those are MCP choices. */
const RUNNER_REQUESTED: RequestedAccess = { write: false, person: false };

export const RUNNER_CONSENT_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};

function flowFields(flow: RunnerConsentFlow): Array<[string, string | null]> {
  switch (flow.kind) {
    case 'cli':
      return [
        ['callback', flow.callback],
        ['client', flow.client],
        ['account_name', flow.accountName],
        ['level', flow.level],
        ['machine', flow.machine],
      ];
    case 'device':
      return [['code', flow.code]];
    case 'edit':
      return [['account', flow.accountId]];
  }
}

/** The flow's parameters back out of a submitted form. */
export function readFlow(kind: RunnerConsentFlow['kind'], form: URLSearchParams): RunnerConsentFlow | null {
  if (kind === 'cli') {
    const callback = form.get('callback');
    if (!callback) return null;
    return {
      kind,
      callback,
      client: form.get('client'),
      accountName: form.get('account_name'),
      level: form.get('level'),
      machine: form.get('machine'),
    };
  }
  if (kind === 'device') {
    const code = form.get('code');
    return code ? { kind, code } : null;
  }
  const accountId = form.get('account');
  return accountId ? { kind, accountId, accountName: '' } : null;
}

// ── Consent token ────────────────────────────────────────────────────────────

const TOKEN_TTL_SECONDS = 10 * 60;

function mac(userId: string, flow: RunnerConsentFlow, issuedAt: number): string {
  const payload = JSON.stringify(['buildd-runner-consent-v1', userId, flow.kind, flowFields(flow), issuedAt]);
  return createHmac('sha256', getJwtSecret()).update(payload).digest('base64url');
}

export function createRunnerConsentToken(userId: string, flow: RunnerConsentFlow, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  return `${issuedAt}.${mac(userId, flow, issuedAt)}`;
}

export function verifyRunnerConsentToken(token: string | null, userId: string, flow: RunnerConsentFlow, now = Date.now()): boolean {
  if (!token) return false;
  const [issuedAtRaw, given] = token.split('.');
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isInteger(issuedAt) || !given) return false;
  const age = Math.floor(now / 1000) - issuedAt;
  if (age < 0 || age > TOKEN_TTL_SECONDS) return false;
  const expected = Buffer.from(mac(userId, flow, issuedAt));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Browsers send `Origin` on form POSTs; a missing or foreign one is refused. */
export function isSameOriginPost(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const allowed = new Set([req.nextUrl.origin]);
  try {
    allowed.add(new URL(getIssuer()).origin);
  } catch {
    // a malformed issuer leaves the request origin
  }
  return allowed.has(origin);
}

// ── Page ─────────────────────────────────────────────────────────────────────

const FOOTNOTE = 'The runner claims work only from the workspaces ticked here, and only while you are on their team. '
  + 'Restricted workspaces show for teams you own or administer. Workspaces created later are not added on their own: '
  + 'change the list in Settings, Connected apps.';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function runnerWording(flow: RunnerConsentFlow): RunnerConsentWording {
  switch (flow.kind) {
    case 'cli':
      return {
        title: 'Connect a runner',
        lede: 'Choose the workspaces this runner claims work from. You can pick from every team you are on.',
        returnsTo: `your terminal (${hostOf(flow.callback)})`,
        approveLabel: 'Connect runner',
        footnote: FOOTNOTE,
      };
    case 'device':
      return {
        title: 'Connect a runner',
        lede: `Choose the workspaces the device showing code ${flow.code} claims work from. You can pick from every team you are on.`,
        returnsTo: `the device showing ${flow.code}`,
        approveLabel: 'Connect runner',
        footnote: FOOTNOTE,
      };
    case 'edit':
      return {
        title: 'Change runner workspaces',
        lede: `Choose the workspaces ${flow.accountName || 'this runner'} claims work from. Its key stays the same.`,
        returnsTo: 'Settings',
        approveLabel: 'Save',
        footnote: FOOTNOTE,
      };
  }
}

/**
 * The first visit: the key's current picks when editing, else the one
 * workspace when the person has exactly one, else nothing (they choose).
 */
export function initialRunnerState(teams: ConsentTeam[], current: readonly string[] | null): ConsentState {
  const offered = teams.flatMap((t) => t.workspaces.map((w) => w.id));
  const selected = current
    ? current.filter((id) => offered.includes(id))
    : offered.length === 1 ? offered : [];
  return { selected, actsAs: 'agent', write: false, query: '', pages: {}, focusTeam: null };
}

export function renderRunnerConsentPage(args: {
  flow: RunnerConsentFlow;
  userId: string;
  teams: ConsentTeam[];
  state: ConsentState;
  action: string;
  error?: string | null;
}): string {
  const wording = runnerWording(args.flow);
  return renderAccountConsentPage({
    clientName: wording.title,
    redirectHost: wording.returnsTo,
    hidden: [...flowFields(args.flow), ['csrf_token', createRunnerConsentToken(args.userId, args.flow)]],
    teams: args.teams,
    state: args.state,
    requested: RUNNER_REQUESTED,
    error: args.error ?? null,
    action: args.action,
    runner: wording,
  });
}

export type RunnerConsentDecision =
  | { type: 'deny' }
  | { type: 'page'; state: ConsentState; error?: string; status?: number }
  | { type: 'refuse'; status: 400 | 403; message: string }
  | { type: 'approve'; workspaceIds: string[] };

/**
 * What a submitted runner consent form asks for, after the origin and token
 * checks: Cancel, a page action (re-render with the carried selection), or an
 * approval checked strictly against what the page offers now.
 */
export function decideRunnerConsent(form: URLSearchParams, teams: ConsentTeam[]): RunnerConsentDecision {
  const decision = form.get('decision');
  if (decision === 'deny') return { type: 'deny' };
  if (decision !== 'approve') {
    const nav = form.get('nav');
    if (!nav) return { type: 'deny' };
    return { type: 'page', state: applyNav(readConsentForm(form, teams, RUNNER_REQUESTED), nav, teams) };
  }
  const check = validateApproval(form, teams, RUNNER_REQUESTED);
  if (!check.ok) {
    if (check.showPage) return { type: 'page', state: readConsentForm(form, teams, RUNNER_REQUESTED), error: check.message, status: check.status };
    return { type: 'refuse', status: check.status, message: check.message };
  }
  return { type: 'approve', workspaceIds: check.workspaceIds };
}

/** A short page after approval: done, and where to go. Never inlines a URL into script. */
export function renderRunnerDonePage(args: { title: string; lede: string; redirectUrl?: string }): string {
  const esc = escapeHtml;
  const refresh = args.redirectUrl ? `<meta http-equiv="refresh" content="1;url=${esc(args.redirectUrl)}">` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(args.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh}
<style>${CONSENT_CSS}</style>
</head>
<body>
<main class="wrap">
<h1>${esc(args.title)}</h1>
<p class="lede">${esc(args.lede)}</p>
</main>
</body>
</html>`;
}
