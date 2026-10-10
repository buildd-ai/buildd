import { describe, expect, it } from 'bun:test';
import {
  CONSENT_PAGE_SIZE,
  applyNav,
  grantedScopeString,
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
  it('escapes names, has no script, and disables person when not asked', () => {
    const evil: ConsentTeam[] = [{ id: 't1', name: '<b>T</b>', role: 'member', workspaces: [{ id: 'w1', name: '"><script>x</script>' }] }];
    const html = renderAccountConsentPage({ clientName: '<i>C</i>', redirectHost: 'h', hidden: [['state', '"x']], teams: evil, state: initialConsentState(evil, agentOnly, null), requested: agentOnly });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;i&gt;C&lt;/i&gt;');
    expect(html).toContain('<input type="hidden" name="state" value="&quot;x">');
    expect(html).toMatch(/id="kind-person" name="acts_as" value="person" disabled/);
    expect(html).toMatch(/id="kind-agent" name="acts_as" value="agent" checked/);
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
