import { frozenCopyHash, normalizeFrozenCopy } from './hash';
import { specCriteria } from './requirements';
import type { SpecSource } from './shapes';
import type { ProposeResult, ProposedChange, SourceVersion, SpecSourceAdapter } from './source';
import { markdownToStorage, storageToMarkdown } from './confluence-markdown';

/**
 * A spec whose home is a Confluence Cloud page (D-1). The page is the text;
 * a version number is a revision; the frozen copy is the page's storage format
 * converted to Markdown, normalized and hashed (./confluence-markdown.ts,
 * ./hash.ts), because Confluence re-serializes storage on save.
 *
 * Agents never edit the page (D-3): a proposal is a child page titled
 * "Proposed vN: <title>" ("Proposed vN (2): <title>" and so on when another
 * proposal on the same base exists, since Confluence titles are unique per
 * space), with the base version and summary kept in a content property, so
 * the parent never shows text nobody approved. Writing an
 * approved proposal back into the parent is the host's act, not this adapter's.
 *
 * I/O is the injected `fetch`, authenticated with `authHeader` (for example a
 * service account's `Basic <base64(email:api-token)>`). Confluence Cloud REST
 * v2, shapes from the published OpenAPI document:
 * - https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/
 *   GET /wiki/api/v2/pages/{id}?body-format=storage&version=N, POST /wiki/api/v2/pages
 * - https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-version/
 *   GET /wiki/api/v2/pages/{id}/versions?limit=&sort=-modified-date
 * - https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-content-properties/
 *   POST /wiki/api/v2/pages/{id}/properties
 * - https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json
 */

export interface ConfluenceSourceOptions {
  /** The site, e.g. `https://example.atlassian.net`. */
  baseUrl: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  authHeader: string;
  /** The account the host writes proposals as; a version it authored reads as an agent's. */
  botAccountId?: string;
  /**
   * `current` (default) publishes a proposal page, so the whole space sees it
   * in the page tree. `draft` keeps it out of the tree; whether a draft page
   * accepts the content property on every Confluence site is untested.
   */
  proposalStatus?: 'current' | 'draft';
}

/** How many numbered titles a proposal tries before it is refused. */
export const MAX_PROPOSAL_TITLE_ATTEMPTS = 20;

/** The content property a proposal page carries. */
export const PROPOSAL_PROPERTY_KEY = 'living-spec-proposal';
export const MAX_VERSIONS_PAGE = 250;

type PageVersion = { number?: number; authorId?: string; createdAt?: string; message?: string };
type Page = { id?: string; title?: string; spaceId?: string; parentId?: string; version?: PageVersion; body?: { storage?: { value?: string } } };

const PAGE_ID = /^\d{1,20}$/;
const VERSION = /^\d{1,9}$/;

export class ConfluenceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function confluenceSource(opts: ConfluenceSourceOptions): SpecSourceAdapter & {
  /** The page's current version number, title and space, for a host that links or approves. */
  currentPage(pageId: string): Promise<{ version: string; title: string; spaceId: string } | null>;
} {
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/wiki/api/v2`;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await opts.fetch(`${base}${path}`, {
      method,
      headers: { Authorization: opts.authHeader, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  }

  const fail = (status: number, what: string): never => {
    throw new ConfluenceError(status, `Confluence ${what} failed with HTTP ${status}`);
  };

  const author = (v: PageVersion | undefined): SourceVersion['author'] =>
    v?.authorId ? { kind: opts.botAccountId && v.authorId === opts.botAccountId ? 'agent' : 'user', id: v.authorId } : undefined;

  const source = (ref: string, version: number | string): SpecSource => ({ kind: 'confluence', ref, version: String(version) });

  async function getPage(pageId: string, query: string): Promise<Page | null> {
    const r = await call('GET', `/pages/${pageId}${query}`);
    if (r.status === 404) return null;
    if (r.status !== 200) fail(r.status, `read of page ${pageId}`);
    return (r.json ?? {}) as Page;
  }

  async function listVersions(ref: string, o?: { limit?: number }) {
    if (!PAGE_ID.test(ref)) return [];
    const limit = Math.min(Math.max(o?.limit ?? 25, 1), MAX_VERSIONS_PAGE);
    const r = await call('GET', `/pages/${ref}/versions?limit=${limit}&sort=-modified-date`);
    if (r.status === 404) return [];
    if (r.status !== 200) fail(r.status, `version list of page ${ref}`);
    const results = ((r.json as { results?: PageVersion[] } | null)?.results ?? []).filter((v) => Number.isInteger(v.number));
    return results
      .sort((a, b) => (b.number as number) - (a.number as number))
      .map((v) => ({ source: source(ref, v.number as number), createdAt: v.createdAt, author: author(v) }));
  }

  return {
    kind: 'confluence',

    async readVersion(ref, version) {
      if (!PAGE_ID.test(ref) || !VERSION.test(version)) return null;
      const page = await getPage(ref, `?body-format=storage&version=${version}`);
      const storage = page?.body?.storage?.value;
      if (!page || typeof storage !== 'string') return null;
      if (page.version?.number !== undefined && String(page.version.number) !== version) return null;
      const body = normalizeFrozenCopy(storageToMarkdown(storage));
      return {
        source: source(ref, version),
        body,
        contentHash: await frozenCopyHash(body),
        author: author(page.version),
        createdAt: page.version?.createdAt,
      };
    },

    listVersions,

    async proposeChange(ref: string, change: ProposedChange): Promise<ProposeResult> {
      if (!PAGE_ID.test(ref)) return { ok: false, reason: 'refused', message: `${ref} is not a Confluence page id` };
      const page = await getPage(ref, '');
      if (!page || !page.spaceId || page.version?.number === undefined) return { ok: false, reason: 'refused', message: `page ${ref} was not found` };
      const current = String(page.version.number);
      if (change.baseVersion !== current) return { ok: false, reason: 'stale', currentVersion: current };
      const next = page.version.number + 1;
      const storage = markdownToStorage(change.body);
      let created: { status: number; json: unknown } = { status: 0, json: null };
      for (let n = 1; n <= MAX_PROPOSAL_TITLE_ATTEMPTS; n++) {
        created = await call('POST', '/pages', {
          spaceId: page.spaceId,
          status: opts.proposalStatus ?? 'current',
          title: `Proposed v${next}${n > 1 ? ` (${n})` : ''}: ${page.title ?? ref}`,
          parentId: ref,
          body: { representation: 'storage', value: storage },
        });
        // A 400 or 409 here is almost always the title being taken by another proposal on the same base.
        if (created.status !== 400 && created.status !== 409) break;
      }
      if (created.status === 400 || created.status === 409) {
        return { ok: false, reason: 'refused', message: `Confluence refused a proposal page for v${next} of this page` };
      }
      if (created.status !== 200) fail(created.status, `create of a proposal under page ${ref}`);
      const childId = (created.json as Page | null)?.id;
      if (!childId) fail(502, `create of a proposal under page ${ref} (no page id returned)`);
      const prop = await call('POST', `/pages/${childId}/properties`, {
        key: PROPOSAL_PROPERTY_KEY,
        value: { parentId: ref, baseVersion: current, summary: change.summary.slice(0, 500) },
      });
      if (prop.status !== 200) fail(prop.status, `recording the proposal on page ${childId}`);
      return { ok: true, proposal: source(childId as string, 1) };
    },

    async versionsSince(ref, since) {
      const after = Number(since);
      if (!Number.isFinite(after)) return [];
      const all = await listVersions(ref, { limit: MAX_VERSIONS_PAGE });
      return all.map((v) => v.source).filter((s) => Number(s.version) > after).sort((a, b) => Number(a.version) - Number(b.version));
    },

    async currentPage(pageId) {
      if (!PAGE_ID.test(pageId)) return null;
      const page = await getPage(pageId, '');
      if (!page || page.version?.number === undefined || !page.spaceId) return null;
      return { version: String(page.version.number), title: page.title ?? '', spaceId: page.spaceId };
    },
  };
}

/**
 * The warning a linked page shows when nothing on it can be verified (AC-14):
 * no requirement or acceptance criterion line survived the conversion.
 */
export function criteriaWarning(markdown: string): string | null {
  if (specCriteria(markdown).length > 0) return null;
  return 'This page has no requirement (R-n) or acceptance criterion (AC-n) lines, so no work can be verified against it. Start a line, list item, heading or bold label with an id such as "R-1:" or "AC-1:", or put the ids in the first column of a table.';
}
