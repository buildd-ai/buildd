/**
 * The push allow-list in outbound.ts: with `pushableBranches` on the grant,
 * only the task's own branch may be moved — by git push, REST or GraphQL —
 * and a request whose target cannot be read is refused. Without it, the
 * protected-branch deny-list (outbound.test.ts) is the only push check.
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyRepoRefWrite,
  needsGithubBodyPeek,
  parseGithubGrant,
  parseReceivePackRefs,
  rewriteOutbound,
  resolveModelRoute,
  type GithubGrant,
} from './outbound';
import { REJECT_REASONS } from './run-report';

const NOW = 1_000_000_000_000;
const model = resolveModelRoute({ AI_GATEWAY_ACCOUNT_ID: 'acct123', AI_GATEWAY_ID: 'gw-1', AI_GATEWAY_TOKEN: 'gw-secret-token' });
const BASE: GithubGrant = { token: 'ghs_real_installation_token', expiresAt: NOW + 60 * 60 * 1000, owner: 'acme', repo: 'widget', protectedBranches: ['main', 'dev'] };
const OWN = 'buildd/abcd1234-fix-thing';
const ALLOW: GithubGrant = { ...BASE, pushableBranches: [OWN] };

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const pkt = (data: string) => (data.length + 4).toString(16).padStart(4, '0') + data;
const PACK = 'PACK\xff\xfe\x00binary-pack-bytes';

/** A receive-pack body: optional shallow lines, one command per ref, flush, pack. */
function push(refs: string[], opts: { shallow?: string[]; oldOid?: string; newOid?: string; flush?: boolean } = {}): string {
  const shallow = (opts.shallow ?? []).map((o) => pkt(`shallow ${o}\n`));
  const cmds = refs.map((ref, i) => pkt(`${opts.oldOid ?? OID_A} ${opts.newOid ?? OID_B} ${ref}${i === 0 ? '\0report-status side-band-64k agent=git/2.47\n' : '\n'}`));
  return shallow.join('') + cmds.join('') + (opts.flush === false ? '' : '0000' + PACK);
}

type Req = { url: string; method: string; bodyPeek?: string };
const decide = (r: Req, grant: GithubGrant | null = ALLOW) =>
  rewriteOutbound({ url: r.url, method: r.method, headers: { authorization: 'Bearer container-supplied' }, ...(r.bodyPeek !== undefined ? { bodyPeek: r.bodyPeek } : {}) }, { model, github: grant, now: NOW });

const RP = 'https://github.com/acme/widget.git/git-receive-pack';
const API = 'https://api.github.com/repos/acme/widget';
const GQL = 'https://api.github.com/graphql';
const json = (v: unknown) => JSON.stringify(v);
const gql = (query: string, variables: unknown = {}) => json({ query, variables });

// [name, request, expected]: 'allow' = forwarded with our credential; else the reject reason.
const CASES: Array<[string, Req, 'allow' | 'push_not_allowed' | 'merge_blocked']> = [
  // git push
  ['push own branch', { url: RP, method: 'POST', bodyPeek: push([`refs/heads/${OWN}`]) }, 'allow'],
  ['push own branch from a shallow clone', { url: RP, method: 'POST', bodyPeek: push([`refs/heads/${OWN}`], { shallow: [OID_A] }) }, 'allow'],
  ['push own branch, sha256 oids', { url: RP, method: 'POST', bodyPeek: push([`refs/heads/${OWN}`], { oldOid: 'a'.repeat(64), newOid: 'b'.repeat(64) }) }, 'allow'],
  ['delete own branch', { url: RP, method: 'POST', bodyPeek: push([`refs/heads/${OWN}`], { newOid: ZERO }) }, 'allow'],
  ['bare flush-pkt (git auth probe)', { url: RP, method: 'POST', bodyPeek: '0000' }, 'allow'],
  ['push another branch', { url: RP, method: 'POST', bodyPeek: push(['refs/heads/buildd/other-task']) }, 'push_not_allowed'],
  ['push own + another branch', { url: RP, method: 'POST', bodyPeek: push([`refs/heads/${OWN}`, 'refs/heads/feature/x']) }, 'push_not_allowed'],
  ['delete another branch', { url: RP, method: 'POST', bodyPeek: push(['refs/heads/feature/x'], { newOid: ZERO }) }, 'push_not_allowed'],
  ['push a tag', { url: RP, method: 'POST', bodyPeek: push(['refs/tags/v1.0.0']) }, 'push_not_allowed'],
  ['push a tag named like the own branch', { url: RP, method: 'POST', bodyPeek: push([`refs/tags/${OWN}`]) }, 'push_not_allowed'],
  ['push a non-branch ref', { url: RP, method: 'POST', bodyPeek: push(['refs/notes/commits']) }, 'push_not_allowed'],
  ['push a bare branch name (not refs/heads/)', { url: RP, method: 'POST', bodyPeek: push([OWN]) }, 'push_not_allowed'],
  ['push a case-variant of the own branch', { url: RP, method: 'POST', bodyPeek: push([`refs/heads/${OWN.toUpperCase()}`]) }, 'push_not_allowed'],
  ['gzip push body', { url: RP, method: 'POST', bodyPeek: '\x1f\x8b\x08\x00\x00\x00\x00\x00' + PACK }, 'push_not_allowed'],
  ['truncated push (no flush-pkt in the peek)', { url: RP, method: 'POST', bodyPeek: push([`refs/heads/${OWN}`], { flush: false }) }, 'push_not_allowed'],
  ['truncated push (cut mid pkt-line)', { url: RP, method: 'POST', bodyPeek: push([`refs/heads/${OWN}`]).slice(0, 30) }, 'push_not_allowed'],
  ['push with no peek', { url: RP, method: 'POST' }, 'push_not_allowed'],
  ['push with an empty body', { url: RP, method: 'POST', bodyPeek: '' }, 'push_not_allowed'],
  ['push with a signed-push certificate', { url: RP, method: 'POST', bodyPeek: pkt('push-cert\0report-status\n') + '0000' }, 'push_not_allowed'],
  ['push to a protected branch (deny-list still wins)', { url: RP, method: 'POST', bodyPeek: push(['refs/heads/main']) }, 'merge_blocked'],
  ['fetch is not a push', { url: 'https://github.com/acme/widget.git/git-upload-pack', method: 'POST', bodyPeek: 'anything' }, 'allow'],

  // REST: git refs
  ['create own branch ref', { url: `${API}/git/refs`, method: 'POST', bodyPeek: json({ ref: `refs/heads/${OWN}`, sha: OID_A }) }, 'allow'],
  ['create another branch ref', { url: `${API}/git/refs`, method: 'POST', bodyPeek: json({ ref: 'refs/heads/feature/x', sha: OID_A }) }, 'push_not_allowed'],
  ['create a tag ref', { url: `${API}/git/refs`, method: 'POST', bodyPeek: json({ ref: 'refs/tags/v1', sha: OID_A }) }, 'push_not_allowed'],
  ['create a ref, unqualified name', { url: `${API}/git/refs`, method: 'POST', bodyPeek: json({ ref: OWN, sha: OID_A }) }, 'push_not_allowed'],
  ['create a ref, no ref field', { url: `${API}/git/refs`, method: 'POST', bodyPeek: json({ sha: OID_A }) }, 'push_not_allowed'],
  ['create a ref, unparseable body', { url: `${API}/git/refs`, method: 'POST', bodyPeek: '{"ref":"refs/heads/' }, 'push_not_allowed'],
  ['create a ref, no peek', { url: `${API}/git/refs`, method: 'POST' }, 'push_not_allowed'],
  ['update own branch ref', { url: `${API}/git/refs/heads/${OWN}`, method: 'PATCH', bodyPeek: json({ sha: OID_B, force: true }) }, 'allow'],
  ['update another branch ref', { url: `${API}/git/refs/heads/feature/x`, method: 'PATCH', bodyPeek: json({ sha: OID_B }) }, 'push_not_allowed'],
  ['update a protected branch ref', { url: `${API}/git/refs/heads/main`, method: 'PATCH', bodyPeek: json({ sha: OID_B, force: true }) }, 'push_not_allowed'],
  ['update a branch ref, percent-encoded path', { url: `${API}/git/refs/heads%2Fmain`, method: 'PATCH', bodyPeek: json({ sha: OID_B }) }, 'push_not_allowed'],
  ['update a branch ref, percent-encoded route segment', { url: `${API}/%67it/refs/heads/main`, method: 'PATCH', bodyPeek: json({ sha: OID_B }) }, 'push_not_allowed'],
  ['update own branch ref, percent-encoded slash', { url: `${API}/git/refs/heads/${encodeURIComponent(OWN)}`, method: 'PATCH', bodyPeek: json({ sha: OID_B }) }, 'allow'],
  ['update a branch ref, doubled slashes', { url: `${API}//git//refs/heads/main`, method: 'PATCH', bodyPeek: json({ sha: OID_B }) }, 'push_not_allowed'],
  ['update a branch ref, upper-case route', { url: `${API}/GIT/REFS/heads/main`, method: 'PATCH', bodyPeek: json({ sha: OID_B }) }, 'push_not_allowed'],
  ['update a tag ref', { url: `${API}/git/refs/tags/v1`, method: 'PATCH', bodyPeek: json({ sha: OID_B }) }, 'push_not_allowed'],
  ['delete own branch ref', { url: `${API}/git/refs/heads/${OWN}`, method: 'DELETE' }, 'allow'],
  ['delete another branch ref', { url: `${API}/git/refs/heads/feature/x`, method: 'DELETE' }, 'push_not_allowed'],
  ['delete a tag ref', { url: `${API}/git/refs/tags/v1`, method: 'DELETE' }, 'push_not_allowed'],
  ['read a ref', { url: `${API}/git/refs/heads/main`, method: 'GET' }, 'allow'],
  ['create a blob / tree / commit / tag object', { url: `${API}/git/commits`, method: 'POST', bodyPeek: json({ message: 'x', tree: OID_A }) }, 'allow'],
  ['create a tag object', { url: `${API}/git/tags`, method: 'POST', bodyPeek: json({ tag: 'v1', object: OID_A }) }, 'allow'],

  // REST: contents
  ['write a file on own branch', { url: `${API}/contents/src/a.ts`, method: 'PUT', bodyPeek: json({ message: 'x', content: 'eA==', branch: OWN }) }, 'allow'],
  ['write a file on own branch (qualified)', { url: `${API}/contents/src/a.ts`, method: 'PUT', bodyPeek: json({ message: 'x', content: 'eA==', branch: `refs/heads/${OWN}` }) }, 'allow'],
  ['write a file on another branch', { url: `${API}/contents/src/a.ts`, method: 'PUT', bodyPeek: json({ message: 'x', content: 'eA==', branch: 'feature/x' }) }, 'push_not_allowed'],
  ['write a file with no branch (default branch)', { url: `${API}/contents/src/a.ts`, method: 'PUT', bodyPeek: json({ message: 'x', content: 'eA==' }) }, 'push_not_allowed'],
  ['write a file, branch only in the query', { url: `${API}/contents/src/a.ts?branch=${encodeURIComponent(OWN)}`, method: 'PUT', bodyPeek: json({ message: 'x', content: 'eA==' }) }, 'push_not_allowed'],
  ['write a file, body cut off by the peek', { url: `${API}/contents/src/a.ts`, method: 'PUT', bodyPeek: json({ message: 'x', content: 'eA'.repeat(100), branch: OWN }).slice(0, 50) }, 'push_not_allowed'],
  ['delete a file on own branch', { url: `${API}/contents/src/a.ts`, method: 'DELETE', bodyPeek: json({ message: 'x', sha: OID_A, branch: OWN }) }, 'allow'],
  ['delete a file on the default branch', { url: `${API}/contents/src/a.ts`, method: 'DELETE', bodyPeek: json({ message: 'x', sha: OID_A }) }, 'push_not_allowed'],
  ['read a file', { url: `${API}/contents/src/a.ts?ref=main`, method: 'GET' }, 'allow'],

  // REST: merges and other ref movers
  ['merge into own branch', { url: `${API}/merges`, method: 'POST', bodyPeek: json({ base: OWN, head: 'main' }) }, 'allow'],
  ['merge into another branch', { url: `${API}/merges`, method: 'POST', bodyPeek: json({ base: 'feature/x', head: OWN }) }, 'push_not_allowed'],
  ['merge with no base', { url: `${API}/merges`, method: 'POST', bodyPeek: json({ head: OWN }) }, 'push_not_allowed'],
  ['sync another branch from upstream', { url: `${API}/merge-upstream`, method: 'POST', bodyPeek: json({ branch: 'main' }) }, 'push_not_allowed'],
  ['rename a branch', { url: `${API}/branches/${OWN}/rename`, method: 'POST', bodyPeek: json({ new_name: 'main' }) }, 'push_not_allowed'],
  ['update a PR branch', { url: `${API}/pulls/7/update-branch`, method: 'PUT' }, 'push_not_allowed'],
  ['create a release (can create a tag ref)', { url: `${API}/releases`, method: 'POST' }, 'push_not_allowed'],
  ['edit a release', { url: `${API}/releases/12`, method: 'PATCH' }, 'push_not_allowed'],
  ['undecodable repo path', { url: `${API}/git/refs/heads/%E0%A4%A`, method: 'PATCH' }, 'push_not_allowed'],
  ['open a PR', { url: `${API}/pulls`, method: 'POST', bodyPeek: json({ head: OWN, base: 'main', title: 't' }) }, 'allow'],
  ['comment on an issue', { url: `${API}/issues/3/comments`, method: 'POST', bodyPeek: json({ body: 'hi' }) }, 'allow'],
  ['list releases', { url: `${API}/releases`, method: 'GET' }, 'allow'],

  // GraphQL
  ['GraphQL query', { url: GQL, method: 'POST', bodyPeek: gql('{ repository(owner: "acme", name: "widget") { id } }') }, 'allow'],
  ['GraphQL createPullRequest', { url: GQL, method: 'POST', bodyPeek: gql('mutation($i: CreatePullRequestInput!) { createPullRequest(input: $i) { pullRequest { url } } }', { i: { headRefName: OWN } }) }, 'allow'],
  ...(['createRef', 'updateRef', 'updateRefs', 'deleteRef', 'createCommitOnBranch', 'mergeBranch', 'updatePullRequestBranch', 'revertPullRequest', 'createLinkedBranch'] as const).map(
    (name): [string, Req, 'push_not_allowed'] => [`GraphQL ${name}, even naming the own branch`, { url: GQL, method: 'POST', bodyPeek: gql(`mutation { ${name}(input: { branchName: "${OWN}" }) { clientMutationId } }`) }, 'push_not_allowed'],
  ),
  ['GraphQL mutation name hidden by a JSON escape', { url: GQL, method: 'POST', bodyPeek: '{"query":"mutation { \\u0063reateRef(input: {}) { clientMutationId } }"}' }, 'push_not_allowed'],
  ['GraphQL merge name hidden by a JSON escape', { url: GQL, method: 'POST', bodyPeek: '{"query":"mutation { \\u006dergePullRequest(input: {}) { clientMutationId } }"}' }, 'merge_blocked'],
  ['GraphQL body cut off by the peek', { url: GQL, method: 'POST', bodyPeek: gql('{ viewer { login } }').slice(0, 12) }, 'push_not_allowed'],
  ['GraphQL body that is not an object with a query', { url: GQL, method: 'POST', bodyPeek: json([{ query: '{ viewer { login } }' }]) }, 'push_not_allowed'],
];

describe('push allow-list: every shape, allowed and refused', () => {
  test.each(CASES)('%s', (_name, r, expected) => {
    const d = decide(r);
    if (expected === 'allow') {
      expect(d.action).toBe('forward');
      if (d.action === 'forward') expect(d.injected).not.toBe('none');
      return;
    }
    expect(d.action).toBe('reject');
    if (d.action !== 'reject') return;
    expect(d.status).toBe(403);
    expect(d.reason).toBe(expected);
    expect(d.message).toContain('merge_pr');
    expect(d.message).not.toContain('ghs_');
    if (expected === 'push_not_allowed') expect(d.message).toContain(OWN);
  });

  test('push_not_allowed is a run-report reject reason, so refusals are counted', () => {
    expect(REJECT_REASONS).toContain('push_not_allowed');
  });

  test('every body-judged REST route is peeked by egress.ts', () => {
    for (const [, r] of CASES) {
      const u = new URL(r.url);
      if (u.hostname !== 'api.github.com' || u.pathname === '/graphql') continue;
      if (classifyRepoRefWrite(r.method, u.pathname)?.check === 'body') expect(needsGithubBodyPeek(u.hostname, r.method, u.pathname)).toBe(true);
    }
    expect(needsGithubBodyPeek('api.github.com', 'POST', '/repos/acme/widget/git/refs')).toBe(true);
    expect(needsGithubBodyPeek('api.github.com', 'PUT', '/repos/acme/widget/contents/a.ts')).toBe(true);
    expect(needsGithubBodyPeek('api.github.com', 'DELETE', '/repos/acme/widget/contents/a.ts')).toBe(true);
    expect(needsGithubBodyPeek('api.github.com', 'POST', '/repos/acme/widget/merges')).toBe(true);
    expect(needsGithubBodyPeek('api.github.com', 'GET', '/repos/acme/widget/contents/a.ts')).toBe(false);
    expect(needsGithubBodyPeek('api.github.com', 'PATCH', '/repos/acme/widget/git/refs/heads/x')).toBe(false);
  });
});

describe('push allow-list: off without the field (older server)', () => {
  const DENY_ONLY: Array<[string, Req, 'allow' | 'merge_blocked']> = [
    ['push another branch', { url: RP, method: 'POST', bodyPeek: push(['refs/heads/feature/x']) }, 'allow'],
    ['push a tag', { url: RP, method: 'POST', bodyPeek: push(['refs/tags/v1']) }, 'allow'],
    ['gzip push', { url: RP, method: 'POST', bodyPeek: '\x1f\x8b\x08\x00' + PACK }, 'allow'],
    ['push with no peek', { url: RP, method: 'POST' }, 'allow'],
    ['push to a protected branch', { url: RP, method: 'POST', bodyPeek: push(['refs/heads/main']) }, 'merge_blocked'],
    ['REST ref update', { url: `${API}/git/refs/heads/feature/x`, method: 'PATCH', bodyPeek: json({ sha: OID_B }) }, 'allow'],
    ['REST contents on default branch', { url: `${API}/contents/a.ts`, method: 'PUT', bodyPeek: json({ message: 'x', content: 'eA==' }) }, 'allow'],
    ['GraphQL createRef', { url: GQL, method: 'POST', bodyPeek: gql('mutation { createRef(input: {}) { clientMutationId } }') }, 'allow'],
    ['GraphQL merge', { url: GQL, method: 'POST', bodyPeek: gql('mutation { mergePullRequest(input: {}) { clientMutationId } }') }, 'merge_blocked'],
  ];
  test.each(DENY_ONLY)('%s', (_name, r, expected) => {
    for (const grant of [BASE, { ...BASE, pushableBranches: [] }]) {
      const d = decide(r, grant);
      if (expected === 'allow') expect(d.action).toBe('forward');
      else expect(d).toMatchObject({ action: 'reject', reason: expected });
    }
  });

  test('no usable grant: nothing is credentialed, so nothing is judged', () => {
    const d = decide({ url: RP, method: 'POST', bodyPeek: push(['refs/heads/feature/x']) }, null);
    expect(d).toMatchObject({ action: 'forward', injected: 'none' });
    const expired = decide({ url: RP, method: 'POST', bodyPeek: push(['refs/heads/feature/x']) }, { ...ALLOW, expiresAt: NOW - 1 });
    expect(expired).toMatchObject({ action: 'forward', injected: 'none' });
  });
});

describe('push allow-list: unrelated hosts are untouched', () => {
  test.each([
    'https://registry.npmjs.org/-/v1/login',
    'https://example.com/repos/acme/widget/git/refs/heads/main',
    'https://gitlab.com/acme/widget.git/git-receive-pack',
  ])('%s', (url) => {
    expect(decide({ url, method: 'POST', bodyPeek: push(['refs/heads/main']) })).toEqual({ action: 'passthrough' });
  });
  test('uploads.github.com release assets are not ref writes', () => {
    expect(decide({ url: 'https://uploads.github.com/repos/acme/widget/releases/1/assets?name=a', method: 'POST' }).action).toBe('forward');
  });
});

describe('parseReceivePackRefs', () => {
  test('reads every command, skipping shallow lines, and stops at the flush-pkt', () => {
    expect(parseReceivePackRefs(push(['refs/heads/a', 'refs/tags/b'], { shallow: [OID_A, OID_B] }))).toEqual(['refs/heads/a', 'refs/tags/b']);
    expect(parseReceivePackRefs('0000')).toEqual([]);
  });
  test('anything it cannot read is null, never a partial list', () => {
    for (const bad of [undefined, '', 'garbage', push(['refs/heads/a'], { flush: false }), pkt('not a command\n') + '0000', '0003']) {
      expect(parseReceivePackRefs(bad)).toBeNull();
    }
  });
});

describe('parseGithubGrant: pushableBranches', () => {
  const base = { token: 'ghs_x', expiresAt: new Date(NOW).toISOString(), repository: { owner: 'acme', name: 'widget' } };
  test('kept when a non-empty array of strings; dropped otherwise', () => {
    expect(parseGithubGrant({ ...base, pushableBranches: [OWN] }).pushableBranches).toEqual([OWN]);
    expect(parseGithubGrant({ ...base, pushableBranches: [OWN, 7, ''] }).pushableBranches).toEqual([OWN]);
    for (const bad of [[], 'x', null, [7]]) {
      expect('pushableBranches' in parseGithubGrant({ ...base, pushableBranches: bad })).toBe(false);
    }
    expect('pushableBranches' in parseGithubGrant(base)).toBe(false);
  });
});
