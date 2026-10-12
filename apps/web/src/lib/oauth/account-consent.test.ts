import { describe, expect, it } from 'bun:test';
import {
  CONSENT_PAGE_SIZE,
  applyNav,
  classifyResource,
  clientIdentity,
  grantedScopeString,
  pickerTeams,
  renderLegacyConsentPage,
  workspaceDetail,
  initialConsentState,
  isAccountResource,
  parseRequestedAccess,
  readConsentForm,
  renderAccountConsentPage,
  validateApproval,
  type ConsentTeam,
} from './account-consent';

const ws = (team: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${team}-w${String(i).padStart(3, '0')}`, name: `${team} ws ${String(i).padStart(3, '0')}` }));
const teams: ConsentTeam[] = [
  { id: 'ta', name: 'Alpha', role: 'owner', workspaces: ws('ta', 45) },
  { id: 'tb', name: 'Beta', role: 'member', workspaces: ws('tb', 2) },
];
const form = (pairs: Array<[string, string]>) => new URLSearchParams(pairs);
const both = { write: true, person: true };
const agentOnly = { write: true, person: false };

describe('requested access from scope', () => {
  it('mcp, buildd:write or no scope ask for write; buildd:read alone does not', () => {
    expect(parseRequestedAccess('mcp')).toEqual({ write: true, person: false });
    expect(parseRequestedAccess(null)).toEqual({ write: true, person: false });
    expect(parseRequestedAccess('buildd:write')).toEqual({ write: true, person: false });
    expect(parseRequestedAccess('buildd:read')).toEqual({ write: false, person: false });
  });
  it('buildd:act-as-person asks for a person connection; unknown scopes are ignored', () => {
    expect(parseRequestedAccess('mcp buildd:act-as-person')).toEqual({ write: true, person: true });
    expect(parseRequestedAccess('buildd:read admin openid')).toEqual({ write: false, person: false });
  });
  it('records only what was granted', () => {
    expect(grantedScopeString(['read'], 'agent')).toBe('buildd:read');
    expect(grantedScopeString(['read', 'write'], 'person')).toBe('buildd:read buildd:write buildd:act-as-person');
  });
  it('matches the account resource with or without a trailing slash, nothing else', () => {
    expect(isAccountResource('https://x.test/api/mcp', 'https://x.test/api/mcp')).toBe(true);
    expect(isAccountResource('https://x.test/api/mcp/', 'https://x.test/api/mcp')).toBe(true);
    expect(isAccountResource('https://x.test/api/mcp-oauth/ws', 'https://x.test/api/mcp')).toBe(false);
    expect(isAccountResource(null, 'https://x.test/api/mcp')).toBe(false);
  });
});

describe('initial state', () => {
  it('defaults to agent and preselects exactly one workspace', () => {
    const s = initialConsentState(teams, agentOnly, null);
    expect(s.actsAs).toBe('agent');
    expect(s.selected).toEqual(['ta-w000']);
  });
  it('is person only when asked, and honours a reachable hint (on its page)', () => {
    const s = initialConsentState(teams, both, 'ta-w030');
    expect(s.actsAs).toBe('person');
    expect(s.selected).toEqual(['ta-w030']);
    expect(s.pages.ta).toBe(2);
  });
  it('ignores a hint the user cannot reach', () => {
    expect(initialConsentState(teams, agentOnly, 'elsewhere').selected).toEqual(['ta-w000']);
  });
});

describe('page actions', () => {
  it('paginates a large team and carries a selection across pages', () => {
    const s0 = readConsentForm(form([['ws', 'ta-w001'], ['acts_as', 'agent']]), teams, agentOnly);
    const s1 = applyNav(s0, 'page:ta:2', teams);
    expect(s1.pages.ta).toBe(2);
    const html = renderAccountConsentPage({ clientName: 'C', redirectHost: 'h', hidden: [], teams, state: s1, requested: agentOnly });
    // page 2 shows workspaces 20..39 and carries the page-1 selection as a hidden field
    expect(html).toContain('value="ta-w020"');
    expect(html).toContain('value="ta-w039"');
    expect(html).not.toContain('<input type="checkbox" name="ws" value="ta-w019"');
    expect(html).toContain('<input type="hidden" name="ws" value="ta-w001">');
    expect(html).toContain('page 2 of 3');
    expect(html).toContain('--carried: 1');
  });
  it('select all, per team and clear', () => {
    const s = readConsentForm(form([]), teams, agentOnly);
    expect(applyNav(s, 'select_all', teams).selected.length).toBe(47);
    expect(applyNav(s, 'team_all:tb', teams).selected.sort()).toEqual(['tb-w000', 'tb-w001']);
    const all = applyNav(s, 'select_all', teams);
    expect(applyNav(all, 'team_clear:ta', teams).selected.sort()).toEqual(['tb-w000', 'tb-w001']);
    expect(applyNav(all, 'clear_all', teams).selected).toEqual([]);
  });
  it('search narrows the list and select all takes only matches', () => {
    const s = readConsentForm(form([['q', 'ws 04']]), teams, agentOnly);
    const searched = applyNav(s, 'search', teams);
    expect(applyNav(searched, 'select_all', teams).selected.sort()).toEqual(['ta-w040', 'ta-w041', 'ta-w042', 'ta-w043', 'ta-w044']);
  });
  it('drops an unreachable id and an unrequested kind on a page action', () => {
    const s = readConsentForm(form([['ws', 'elsewhere'], ['ws', 'tb-w000'], ['acts_as', 'person'], ['perm_write', 'on']]), teams, { write: false, person: false });
    expect(s.selected).toEqual(['tb-w000']);
    expect(s.actsAs).toBe('agent');
    expect(s.write).toBe(false);
  });
  it('ignores an action on an unknown team', () => {
    const s = readConsentForm(form([['ws', 'tb-w000']]), teams, agentOnly);
    expect(applyNav(s, 'team_all:nope', teams)).toBe(s);
  });
});

describe('approval validation', () => {
  it('rejects an unreachable workspace without naming it', () => {
    const r = validateApproval(form([['ws', 'tb-w000'], ['ws', 'elsewhere']]), teams, agentOnly);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(403); expect(r.message).not.toContain('elsewhere'); }
  });
  it('rejects person when the client did not ask, and unknown kinds', () => {
    expect(validateApproval(form([['ws', 'tb-w000'], ['acts_as', 'person']]), teams, agentOnly).ok).toBe(false);
    expect(validateApproval(form([['ws', 'tb-w000'], ['acts_as', 'owner']]), teams, both).ok).toBe(false);
  });
  it('defaults to agent and honours a downgrade', () => {
    const d = validateApproval(form([['ws', 'tb-w000']]), teams, both);
    expect(d.ok && d.actsAs).toBe('agent');
    const p = validateApproval(form([['ws', 'tb-w000'], ['acts_as', 'person']]), teams, both);
    expect(p.ok && p.actsAs).toBe('person');
  });
  it('write only when asked; unchecked write is read only', () => {
    expect(validateApproval(form([['ws', 'tb-w000'], ['perm_write', 'on']]), teams, { write: false, person: false }).ok).toBe(false);
    const ro = validateApproval(form([['ws', 'tb-w000']]), teams, agentOnly);
    expect(ro.ok && ro.scopes).toEqual(['read']);
    const rw = validateApproval(form([['ws', 'tb-w000'], ['perm_write', 'on']]), teams, agentOnly);
    expect(rw.ok && rw.scopes).toEqual(['read', 'write']);
  });
  it('asks again for an empty selection', () => {
    const r = validateApproval(form([]), teams, agentOnly);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.showPage).toBe(true);
  });
});

describe('render', () => {
  it('escapes names, has no script, and offers no person choice when not asked', () => {
    const evil: ConsentTeam[] = [{ id: 't1', name: '<b>T</b>', role: 'member', workspaces: [{ id: 'w1', name: '"><script>x</script>' }] }];
    const html = renderAccountConsentPage({ clientName: '<i>C</i>', redirectHost: 'h', hidden: [['state', '"x']], teams: evil, state: initialConsentState(evil, agentOnly, null), requested: agentOnly });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;i&gt;C&lt;/i&gt;');
    expect(html).toContain('<input type="hidden" name="state" value="&quot;x">');
    expect(html).not.toContain('id="kind-person"');
    expect(html).toContain('<input type="hidden" name="acts_as" value="agent">');
  });
  it('offers both kinds, agent first, when the app asks to act as the person', () => {
    const html = renderAccountConsentPage({ clientName: 'C', redirectHost: 'h', hidden: [], teams, state: initialConsentState(teams, both, null), requested: both });
    expect(html).toMatch(/id="kind-agent" name="acts_as" value="agent"/);
    expect(html).toMatch(/id="kind-person" name="acts_as" value="person" checked/);
    expect(html.indexOf('id="kind-agent"')).toBeLessThan(html.indexOf('id="kind-person"'));
  });
  it('the first submit button is Search, so Enter in the search box never approves', () => {
    const html = renderAccountConsentPage({ clientName: 'C', redirectHost: 'h', hidden: [], teams, state: initialConsentState(teams, agentOnly, null), requested: agentOnly });
    const first = html.match(/<button[^>]*type="submit"[^>]*>/)![0];
    expect(first).toContain('value="search"');
  });
  it('page size is bounded', () => {
    expect(CONSENT_PAGE_SIZE).toBeLessThanOrEqual(50);
  });
});

const ISSUER_MCP = 'https://buildd.dev/api/mcp';
const UUID = '0b6f3a52-6d0e-4d8e-9a43-2f1c7e5b9a10';

describe('resource classification', () => {
  it('no resource is none: the account level is the default for a new connection', () => {
    expect(classifyResource(null, ISSUER_MCP)).toEqual({ kind: 'none' });
    expect(classifyResource('', ISSUER_MCP)).toEqual({ kind: 'none' });
  });
  it('the account resource, with a trailing slash or a connection hint', () => {
    expect(classifyResource('https://buildd.dev/api/mcp', ISSUER_MCP).kind).toBe('account');
    expect(classifyResource('https://buildd.dev/api/mcp/', ISSUER_MCP).kind).toBe('account');
    expect(classifyResource('https://buildd.dev/api/mcp?repo=acme/api', ISSUER_MCP).kind).toBe('account');
  });
  it('an older per-workspace address names exactly its workspace', () => {
    expect(classifyResource(`https://buildd.dev/api/mcp-oauth/${UUID}`, ISSUER_MCP)).toEqual({ kind: 'legacy', workspaceId: UUID });
    expect(classifyResource(`https://buildd.dev/api/mcp-oauth/${UUID}/`, ISSUER_MCP)).toEqual({ kind: 'legacy', workspaceId: UUID });
  });
  it('another host, another path, or a fragment is unknown, never redirected', () => {
    expect(classifyResource('https://evil.example/api/mcp', ISSUER_MCP).kind).toBe('unknown');
    expect(classifyResource(`https://evil.example/api/mcp-oauth/${UUID}`, ISSUER_MCP).kind).toBe('unknown');
    expect(classifyResource('https://buildd.dev', ISSUER_MCP).kind).toBe('unknown');
    expect(classifyResource('https://buildd.dev/api/mcp/c/x', ISSUER_MCP).kind).toBe('unknown');
    expect(classifyResource('https://buildd.dev/api/mcp#x', ISSUER_MCP).kind).toBe('unknown');
    expect(classifyResource('not a url', ISSUER_MCP).kind).toBe('unknown');
  });
});

describe('client identity', () => {
  it('names ChatGPT and Claude as verified only on their own redirect hosts', () => {
    expect(clientIdentity('ChatGPT connector 123', 'https://chatgpt.com/connector_platform_oauth_redirect')).toEqual({ name: 'ChatGPT', verified: true });
    expect(clientIdentity('claudeai', 'https://claude.ai/api/mcp/auth_callback')).toEqual({ name: 'Claude', verified: true });
  });
  it('keeps a registered name unverified elsewhere, even one that claims to be ChatGPT', () => {
    expect(clientIdentity('ChatGPT', 'https://chatgpt.com.evil.example/cb')).toEqual({ name: 'ChatGPT', verified: false });
    expect(clientIdentity('ChatGPT', 'http://chatgpt.com/cb')).toEqual({ name: 'ChatGPT', verified: false });
    expect(clientIdentity('Claude Code', 'http://localhost:41776/callback')).toEqual({ name: 'Claude Code', verified: false });
  });
  it('the page says Authorize <app>, marks verification, and shows where an unverified app returns', () => {
    const v = renderAccountConsentPage({ clientName: 'ChatGPT', clientVerified: true, redirectHost: 'chatgpt.com', hidden: [], teams, state: initialConsentState(teams, agentOnly, null), requested: agentOnly });
    expect(v).toContain('<h1>Authorize ChatGPT</h1>');
    expect(v).toContain('Choose the teams and workspaces ChatGPT can access.');
    expect(v).toContain('data-client-verified="true"');
    const u = renderAccountConsentPage({ clientName: 'Some app', redirectHost: 'apps.example', hidden: [], teams, state: initialConsentState(teams, agentOnly, null), requested: agentOnly });
    expect(u).toContain('data-client-verified="false"');
    expect(u).toContain('apps.example');
  });
});

const sysTeams: ConsentTeam[] = [
  { id: 'ta', name: 'Alpha', role: 'owner', workspaces: [
    { id: 'coord-a', name: '__coordination', repo: null, system: true },
    { id: 'api-a', name: 'api', repo: 'acme/api', system: false },
  ] },
  { id: 'tb', name: 'Beta', role: 'member', workspaces: [
    { id: 'coord-b', name: '__coordination', repo: null, system: true },
  ] },
];

describe('internal workspaces', () => {
  it('are left out of the picker, and a team with nothing else is dropped', () => {
    const t = pickerTeams(sysTeams, null);
    expect(t.map((x) => x.id)).toEqual(['ta']);
    expect(t[0].workspaces.map((w) => w.id)).toEqual(['api-a']);
  });
  it('stay choosable when the app named one explicitly and the person is a team admin', () => {
    expect(pickerTeams(sysTeams, 'coord-a')[0].workspaces.map((w) => w.id)).toEqual(['coord-a', 'api-a']);
    // a member of the team gets no internal workspace, named or not
    expect(pickerTeams(sysTeams, 'coord-b').map((x) => x.id)).toEqual(['ta']);
  });
  it('an internal workspace that was not offered is refused on approval', () => {
    const r = validateApproval(form([['ws', 'api-a'], ['ws', 'coord-a']]), pickerTeams(sysTeams, null), agentOnly);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
  it('a named one reads as Organizer, never as its raw name', () => {
    const t = pickerTeams(sysTeams, 'coord-a');
    const html = renderAccountConsentPage({ clientName: 'C', redirectHost: 'h', hidden: [], teams: t, state: initialConsentState(t, agentOnly, 'coord-a'), requested: agentOnly });
    expect(html).toContain('Organizer');
    expect(html).not.toContain('__coordination');
  });
});

describe('telling workspaces apart', () => {
  const dupTeam: ConsentTeam = { id: 't', name: 'T', role: 'member', workspaces: [
    { id: 'aaaaaaaa-1', name: 'api', repo: 'acme/api' },
    { id: 'bbbbbbbb-2', name: 'api', repo: 'acme/api-v2' },
    { id: 'cccccccc-3', name: 'docs', repo: null },
    { id: 'dddddddd-4', name: 'docs', repo: null },
    { id: 'eeeeeeee-5', name: 'site', repo: null },
  ] };
  it('shows the repo, and a short id only when name and repo still clash', () => {
    expect(workspaceDetail(dupTeam, dupTeam.workspaces[0])).toBe('acme/api');
    expect(workspaceDetail(dupTeam, dupTeam.workspaces[1])).toBe('acme/api-v2');
    expect(workspaceDetail(dupTeam, dupTeam.workspaces[2])).toBe('id cccccccc');
    expect(workspaceDetail(dupTeam, dupTeam.workspaces[4])).toBeNull();
  });
  it('the page never prints a full workspace id as text', () => {
    const t: ConsentTeam[] = [{ id: 'tt', name: 'Acme', role: 'member', workspaces: [{ id: UUID, name: 'api', repo: 'acme/api' }] }];
    const html = renderAccountConsentPage({ clientName: 'C', redirectHost: 'h', hidden: [], teams: t, state: initialConsentState(t, agentOnly, null), requested: agentOnly });
    expect(html.split(UUID).length - 1).toBe(1); // only the checkbox value
    expect(html).toContain('acme/api');
  });
  it('search matches the repo', () => {
    const s = applyNav(readConsentForm(form([['q', 'api-v2']]), [dupTeam], agentOnly), 'search', [dupTeam]);
    expect(applyNav(s, 'select_all', [dupTeam]).selected).toEqual(['bbbbbbbb-2']);
  });
  it('says so when a search matches nothing', () => {
    const s = applyNav(readConsentForm(form([['q', 'zzz']]), teams, agentOnly), 'search', teams);
    const html = renderAccountConsentPage({ clientName: 'C', redirectHost: 'h', hidden: [], teams, state: s, requested: agentOnly });
    expect(html).toContain('data-empty="search"');
    expect(html).toContain('No workspaces match');
  });
});

describe('select all is the workspaces of now', () => {
  it('an approval of every current workspace grants exactly those ids', () => {
    const all = applyNav(readConsentForm(form([]), teams, agentOnly), 'select_all', teams);
    const r = validateApproval(form(all.selected.map((id) => ['ws', id] as [string, string])), teams, agentOnly);
    expect(r.ok && r.workspaceIds.length).toBe(47);
    // a workspace created after the page rendered is not part of the approval
    const later: ConsentTeam[] = [{ ...teams[0], workspaces: [...teams[0].workspaces, { id: 'ta-new', name: 'new' }] }, teams[1]];
    const again = validateApproval(form(all.selected.map((id) => ['ws', id] as [string, string])), later, agentOnly);
    expect(again.ok && again.workspaceIds.includes('ta-new')).toBe(false);
  });
});

describe('actions and copy', () => {
  it('says Allow access and Cancel, never one connector per workspace', () => {
    const html = renderAccountConsentPage({ clientName: 'C', redirectHost: 'h', hidden: [], teams, state: initialConsentState(teams, agentOnly, null), requested: agentOnly });
    expect(html).toContain('>Allow access</button>');
    expect(html).toContain('>Cancel</button>');
    expect(html).not.toMatch(/separate connector/i);
    expect(html).not.toContain('—');
  });
});

describe('older per-workspace address', () => {
  const page = () => renderLegacyConsentPage({
    clientName: 'ChatGPT',
    clientVerified: true,
    redirectHost: 'chatgpt.com',
    hidden: [['resource', `https://buildd.dev/api/mcp-oauth/${UUID}`]],
    workspace: { name: 'api', teamName: 'Acme', repo: 'acme/api' },
    level: 'worker',
    canonicalUrl: ISSUER_MCP,
  });
  it('offers that one workspace, named by team and repo, with no picker', () => {
    const html = page();
    expect(html).toContain('data-consent="legacy"');
    expect(html).toContain('Acme');
    expect(html).toContain('acme/api');
    expect(html).not.toContain('<input type="checkbox" name="ws"');
    expect(html).not.toMatch(/<script/i);
  });
  it('points at the one address that reaches several workspaces, not at more connectors', () => {
    const html = page();
    expect(html).toContain(`<span class="addr">${ISSUER_MCP}</span>`);
    expect(html).not.toMatch(/separate connector/i);
    expect(html).toContain('>Allow access</button>');
    expect(html).not.toContain('—');
  });
});

describe('token parity with globals.css', () => {
  // The page is standalone (no app stylesheet), so it restates the colour
  // tokens. Each one must equal the app's value in the same theme.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const { CONSENT_CSS } = require('./account-consent') as typeof import('./account-consent');
  const globals = readFileSync(join(import.meta.dir, '../../app/globals.css'), 'utf8');
  const block = (css: string, start: string) => {
    const i = css.indexOf(start);
    expect(i).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf('}', i));
  };
  const vars = (css: string) => {
    const out: Record<string, string> = {};
    for (const m of css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\s+/g, '');
    return out;
  };
  const appNight = vars(block(globals, ':root, [data-theme="dark"] {'));
  const appDay = vars(block(globals, '[data-theme="light"] {'));
  const pageNight = vars(block(CONSENT_CSS, ':root {'));
  const pageDay = vars(block(CONSENT_CSS, '@media (prefers-color-scheme: light) {\n  :root {'));
  const colour = (v: string) => /^(#|rgba?\()/.test(v);

  it('night colours match', () => {
    const keys = Object.keys(pageNight).filter((k) => colour(pageNight[k]));
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) expect([k, pageNight[k]]).toEqual([k, appNight[k]]);
  });
  it('day colours match', () => {
    const keys = Object.keys(pageDay).filter((k) => colour(pageDay[k]));
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) expect([k, pageDay[k]]).toEqual([k, appDay[k]]);
  });
});
