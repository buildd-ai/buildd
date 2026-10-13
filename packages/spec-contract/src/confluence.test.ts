import { describe, expect, it } from 'bun:test';
import { confluenceSource, criteriaWarning, PROPOSAL_PROPERTY_KEY } from './confluence';
import { decodeEntities, markdownToStorage, storageToMarkdown } from './confluence-markdown';
import { frozenCopyHash, normalizeFrozenCopy } from './hash';
import { specCriteria } from './requirements';
import { criterionChecks } from './check-lines';

// A spec page as Confluence stores it: headings, a status macro, a nested
// list, a requirements table with ids in the first column, a code macro, an
// info panel, a page link and the entities a re-save scatters.
const PAGE = `<h1>Cart&nbsp;totals</h1>
<p>Status: <ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">IN REVIEW</ac:parameter><ac:parameter ac:name="colour">Yellow</ac:parameter></ac:structured-macro> &mdash; owner <ac:link><ri:user ri:account-id="u-1" /></ac:link></p>
<h2>Decisions</h2>
<ul><li><strong>D-1</strong> Prices come from the catalogue.</li></ul>
<h2>Requirements</h2>
<table data-layout="default"><colgroup><col /><col /><col /></colgroup><tbody>
<tr><th><p>ID</p></th><th><p>Requirement</p></th><th><p>Check</p></th></tr>
<tr><td><p>R-1</p></td><td><p>Totals are in the shopper&#39;s <em>currency</em>.</p></td><td><p><code>bun test fx</code></p></td></tr>
<tr><td><p><strong>R-2</strong></p></td><td><p>Rates refresh every 15&nbsp;minutes | at most.</p></td><td><p></p></td></tr>
</tbody></table>
<h2>Acceptance criteria</h2>
<ol>
  <li>AC-1: Given a cart in EUR, the total reads in &euro;uro.
    <ul><li>Includes <a href="https://example.test/fx">rounding</a></li><li>See <ac:link><ri:page ri:content-title="Rates service" /></ac:link></li></ul>
  </li>
  <li>AC-2: An empty cart shows the empty state.<br/>No total is shown.</li>
</ol>
<ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[const total = sum(lines) * rate;
if (a < b && c) {}]]></ac:plain-text-body></ac:structured-macro>
<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Note</ac:parameter><ac:rich-text-body><p>Out of scope: taxes.</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>Hidden detail.</p></ac:rich-text-body></ac:structured-macro>
<hr/>`;

describe('storageToMarkdown', () => {
  const md = storageToMarkdown(PAGE);

  it('renders headings, macros, lists, tables, code and callouts as Markdown', () => {
    expect(md).toContain('# Cart totals\n');
    expect(md).toContain('Status: IN REVIEW — owner');
    expect(md).toContain('- **D-1** Prices come from the catalogue.');
    expect(md).toContain('| ID | Requirement | Check |\n| --- | --- | --- |');
    expect(md).toContain("| R-1 | Totals are in the shopper's *currency*. | `bun test fx` |");
    expect(md).toContain('| **R-2** | Rates refresh every 15 minutes \\| at most. |  |');
    expect(md).toContain('1. AC-1: Given a cart in EUR, the total reads in €uro.\n  - Includes [rounding](https://example.test/fx)\n  - See Rates service');
    expect(md).toContain('2. AC-2: An empty cart shows the empty state. No total is shown.');
    expect(md).toContain('```ts\nconst total = sum(lines) * rate;\nif (a < b && c) {}\n```');
    expect(md).toContain('> **Note**\n>\n> Out of scope: taxes.');
    expect(md).toContain('Hidden detail.');
    expect(md).toContain('\n---\n');
    expect(md).not.toMatch(/<\/?(p|ac:|ri:|td|li|strong|h\d)\b/);
  });

  it('restates a table\'s criterion ids as lines the id parser reads, so every criterion survives', () => {
    expect(md).toContain("- **R-1** Totals are in the shopper's *currency*. — `bun test fx`");
    expect(md).toContain('- **R-2** Rates refresh every 15 minutes | at most.');
    expect(specCriteria(md).map((c) => c.id)).toEqual(['R-1', 'R-2', 'AC-1', 'AC-2']);
    expect(criteriaWarning(md)).toBeNull();
  });

  it('degrades unknown or broken markup to its text instead of failing', () => {
    expect(storageToMarkdown('<p>a <ac:structured-macro ac:name="mystery"><ac:parameter ac:name="x">y</ac:parameter>kept</ac:structured-macro> b</p>')).toBe('a kept b\n');
    expect(storageToMarkdown('<p>unclosed <strong>bold</p><p>next</em></p>')).toBe('unclosed **bold**\n\nnext\n');
    expect(storageToMarkdown('')).toBe('\n');
  });

  it('decodes named and numeric entities, and nbsp reads as a space', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&#39;&nbsp;&#x41;&#66;&#160;&bogus;')).toBe('&<>"\' AB &bogus;');
  });
});

describe('a re-save that only moved whitespace is the same version', () => {
  it('hashes two serializations of the same page the same', async () => {
    const a = '<h2>Goal</h2><p>Totals&nbsp;are in EUR.</p><ul><li><p>AC-1: shows &euro;</p></li></ul>';
    const b = '<h2>Goal</h2>\n\n  <p>Totals are\n   in EUR. </p>\n<ul>\n  <li><p>AC-1:  shows &euro;</p></li>\n</ul>\n';
    const ha = await frozenCopyHash(normalizeFrozenCopy(storageToMarkdown(a)));
    const hb = await frozenCopyHash(normalizeFrozenCopy(storageToMarkdown(b)));
    expect(ha).toBe(hb);
    const changed = await frozenCopyHash(normalizeFrozenCopy(storageToMarkdown(a.replace('EUR', 'USD'))));
    expect(changed).not.toBe(ha);
  });
});

describe('criteriaWarning', () => {
  it('warns on a page with no R-n or AC-n lines', () => {
    expect(criteriaWarning(storageToMarkdown('<h1>Ideas</h1><p>Some notes. D-1 is not a criterion.</p>'))).toContain('no requirement (R-n) or acceptance criterion (AC-n)');
  });
});

describe('markdownToStorage', () => {
  it('writes headings, paragraphs, nested lists, code fences, quotes and inline marks', () => {
    const xml = markdownToStorage('# Title\n\nSome **bold** and `a<b` with [a link](https://x.test).\n\n- **AC-1** One\n  - nested\n- AC-2 Two\n\n1. first\n2. second\n\n```ts\nconst x = 1 && 2;\n```\n\n> quoted\n');
    expect(xml).toContain('<h1>Title</h1>');
    expect(xml).toContain('<p>Some <strong>bold</strong> and <code>a&lt;b</code> with <a href="https://x.test">a link</a>.</p>');
    expect(xml).toContain('<ul><li><strong>AC-1</strong> One<ul><li>nested</li></ul></li><li>AC-2 Two</li></ul>');
    expect(xml).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(xml).toContain('<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[const x = 1 && 2;]]></ac:plain-text-body></ac:structured-macro>');
    expect(xml).toContain('<blockquote><p>quoted</p></blockquote>');
  });

  it('round-trips a spec: its criteria and checks survive storage and back', () => {
    const spec = '# Cart\n\n- **R-1** Totals are in the shopper\'s currency.\n  check: `bun test fx`\n- **AC-1** An empty cart shows the empty state.\n';
    const back = storageToMarkdown(markdownToStorage(spec));
    expect(specCriteria(back).map((c) => c.id)).toEqual(['R-1', 'AC-1']);
    expect(back).toContain("- **R-1** Totals are in the shopper's currency.");
  });
});

// ── The adapter, against a fake Confluence ──────────────────────────────────

type Call = { method: string; url: string; body?: any };
function fakeConfluence(pages: Record<string, { title: string; spaceId: string; versions: Array<{ number: number; authorId: string; storage: string; createdAt: string }> }>) {
  const calls: Call[] = [];
  let nextId = 900;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    const path = u.pathname.replace('/wiki/api/v2', '');
    if ((init?.headers as Record<string, string>)?.Authorization !== 'Basic test') return json(401, {});
    let m = /^\/pages\/(\d+)$/.exec(path);
    if (m && method === 'GET') {
      const p = pages[m[1]!];
      if (!p) return json(404, {});
      const want = u.searchParams.get('version');
      const v = want ? p.versions.find((x) => x.number === Number(want)) : p.versions[p.versions.length - 1];
      if (!v) return json(404, {});
      return json(200, { id: m[1], title: p.title, spaceId: p.spaceId, version: { number: v.number, authorId: v.authorId, createdAt: v.createdAt }, ...(u.searchParams.get('body-format') === 'storage' ? { body: { storage: { representation: 'storage', value: v.storage } } } : {}) });
    }
    m = /^\/pages\/(\d+)\/versions$/.exec(path);
    if (m && method === 'GET') {
      const p = pages[m[1]!];
      if (!p) return json(404, {});
      const limit = Number(u.searchParams.get('limit') ?? 25);
      // Deliberately out of order: the adapter sorts.
      const results = [...p.versions].sort((a, b) => (a.number % 2) - (b.number % 2)).slice(0, limit).map((v) => ({ number: v.number, authorId: v.authorId, createdAt: v.createdAt }));
      return json(200, { results, _links: {} });
    }
    if (path === '/pages' && method === 'POST') {
      const dup = Object.values(pages).some((p) => p.title === body.title && p.spaceId === body.spaceId);
      if (dup) return json(400, { errors: [{ title: 'A page with this title already exists' }] });
      const id = String(nextId++);
      pages[id] = { title: body.title, spaceId: body.spaceId, versions: [{ number: 1, authorId: 'bot', storage: body.body.value, createdAt: '2026-10-12T00:00:00.000Z' }] };
      return json(200, { id, title: body.title, spaceId: body.spaceId, parentId: body.parentId, version: { number: 1 } });
    }
    m = /^\/pages\/(\d+)\/properties$/.exec(path);
    if (m && method === 'POST') return json(200, { id: 'p1', key: body.key, value: body.value });
    return json(405, {});
  };
  return { fetch, calls, pages };
}

const SITE = 'https://example.atlassian.net/';
const v = (number: number, authorId: string, storage: string) => ({ number, authorId, storage, createdAt: `2026-10-${10 + number}T00:00:00.000Z` });

function setup() {
  const fake = fakeConfluence({
    '101': { title: 'Cart totals', spaceId: 's-1', versions: [v(1, 'u-1', '<p>R-1: one</p>'), v(2, 'u-2', '<p>R-1: one</p><p>AC-1: two</p>'), v(3, 'bot', '<p>R-1: one</p><p>AC-1: two!</p>')] },
  });
  const src = confluenceSource({ baseUrl: SITE, fetch: fake.fetch, authHeader: 'Basic test', botAccountId: 'bot' });
  return { fake, src };
}

describe('confluenceSource', () => {
  it('reads one exact version as a normalized, hashed Markdown copy, with who wrote it', async () => {
    const { fake, src } = setup();
    const r = await src.readVersion('101', '2');
    expect(r).toMatchObject({ source: { kind: 'confluence', ref: '101', version: '2' }, body: 'R-1: one\n\nAC-1: two\n', author: { kind: 'user', id: 'u-2' } });
    expect(r!.contentHash).toBe(await frozenCopyHash('R-1: one\n\nAC-1: two\n'));
    expect(fake.calls[0]!.url).toBe('https://example.atlassian.net/wiki/api/v2/pages/101?body-format=storage&version=2');
    expect((await src.readVersion('101', '3'))!.author).toEqual({ kind: 'agent', id: 'bot' });
    expect(criterionChecks((await src.readVersion('101', '1'))!.body)).toEqual([]);
  });

  it('a missing page or version, or a malformed id, is null and never "the latest"', async () => {
    const { fake, src } = setup();
    expect(await src.readVersion('404', '1')).toBeNull();
    expect(await src.readVersion('101', '9')).toBeNull();
    const before = fake.calls.length;
    expect(await src.readVersion('../etc', '1')).toBeNull();
    expect(await src.readVersion('101', 'latest')).toBeNull();
    expect(fake.calls.length).toBe(before);
  });

  it('lists versions newest first, and versionsSince oldest first', async () => {
    const { src } = setup();
    expect((await src.listVersions('101')).map((x) => x.source.version)).toEqual(['3', '2', '1']);
    expect((await src.listVersions('101', { limit: 1000 })).length).toBe(3);
    expect(await src.versionsSince('101', '1')).toEqual([{ kind: 'confluence', ref: '101', version: '2' }, { kind: 'confluence', ref: '101', version: '3' }]);
    expect(await src.versionsSince('101', '3')).toEqual([]);
    expect(await src.listVersions('404')).toEqual([]);
  });

  it('a proposal on a stale version is refused, and nothing is written', async () => {
    const { fake, src } = setup();
    expect(await src.proposeChange('101', { body: 'x', summary: 's', baseVersion: '2' })).toEqual({ ok: false, reason: 'stale', currentVersion: '3' });
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('a proposal is a child page under the spec page with its base and summary recorded; the spec page is never written', async () => {
    const { fake, src } = setup();
    const r = await src.proposeChange('101', { body: '- **AC-1** two, fixed\n', summary: 'Fix AC-1', baseVersion: '3' });
    expect(r).toEqual({ ok: true, proposal: { kind: 'confluence', ref: '900', version: '1' } });
    const create = fake.calls.find((c) => c.method === 'POST' && c.url.endsWith('/wiki/api/v2/pages'))!;
    expect(create.body).toEqual({ spaceId: 's-1', status: 'current', title: 'Proposed v4: Cart totals', parentId: '101', body: { representation: 'storage', value: '<ul><li><strong>AC-1</strong> two, fixed</li></ul>' } });
    const prop = fake.calls.find((c) => c.url.endsWith('/pages/900/properties'))!;
    expect(prop.body).toEqual({ key: PROPOSAL_PROPERTY_KEY, value: { parentId: '101', baseVersion: '3', summary: 'Fix AC-1' } });
    expect(fake.calls.some((c) => c.method !== 'GET' && /\/pages\/101(\b|$|\?)/.test(new URL(c.url).pathname))).toBe(false);
    expect(fake.pages['101']!.versions.length).toBe(3);
    // A second proposal on the same base gets its own page instead of colliding on the title.
    const second = await src.proposeChange('101', { body: 'y', summary: 's', baseVersion: '3' });
    expect(second).toMatchObject({ ok: true, proposal: { kind: 'confluence', ref: '901' } });
    expect(fake.pages['901']!.title).toBe('Proposed v4 (2): Cart totals');
  });

  it('a proposal title never carries an em or en dash', async () => {
    const { fake, src } = setup();
    await src.proposeChange('101', { body: 'x', summary: 's', baseVersion: '3' });
    const create = fake.calls.find((c) => c.method === 'POST' && c.url.endsWith('/wiki/api/v2/pages'))!;
    expect(create.body.title).not.toMatch(/[\u2013\u2014]/);
  });

  it('a host can create proposals as drafts, so the space page tree does not show them', async () => {
    const fake = fakeConfluence({ '101': { title: 'Cart totals', spaceId: 's-1', versions: [v(1, 'u', '<p>R-1: x</p>')] } });
    const src = confluenceSource({ baseUrl: SITE, fetch: fake.fetch, authHeader: 'Basic test', proposalStatus: 'draft' });
    await src.proposeChange('101', { body: 'x', summary: 's', baseVersion: '1' });
    const create = fake.calls.find((c) => c.method === 'POST' && c.url.endsWith('/wiki/api/v2/pages'))!;
    expect(create.body.status).toBe('draft');
  });

  it('an auth failure throws with the status, rather than reading as a missing page', async () => {
    const fake = fakeConfluence({ '101': { title: 't', spaceId: 's', versions: [v(1, 'u', '<p>R-1: x</p>')] } });
    const src = confluenceSource({ baseUrl: SITE, fetch: fake.fetch, authHeader: 'Basic wrong' });
    await expect(src.readVersion('101', '1')).rejects.toMatchObject({ status: 401 });
  });

  it('reads the current page for a host linking it', async () => {
    const { src } = setup();
    expect(await src.currentPage('101')).toEqual({ version: '3', title: 'Cart totals', spaceId: 's-1' });
    expect(await src.currentPage('404')).toBeNull();
  });
});
