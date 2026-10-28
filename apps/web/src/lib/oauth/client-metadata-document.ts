// OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-
// document, adopted by the MCP authorization spec 2025-11-25). A client whose
// `client_id` is an HTTPS URL is described by the JSON document served at that
// URL, so it needs no registration call. Claude's hosted apps
// (https://claude.ai/oauth/mcp-oauth-client-metadata) and Claude Code
// (https://claude.ai/oauth/claude-code-client-metadata) use this whenever the
// authorization server metadata advertises `client_id_metadata_document_supported`.
//
// Fetching a URL a stranger supplies is a server-side request forgery surface,
// so the fetch is fenced: HTTPS on the default port, a DNS name (never an IP
// literal) whose every address is public, no redirects, a short timeout and a
// small size cap. The document is self-asserted: it never makes a client
// "verified" (that is decided by redirect host, account-consent.ts), and a
// reserved name is held to its own hosts as at registration.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isSafeRedirectUri, reservedNameAllowed } from './client-policy';

const MAX_DOCUMENT_BYTES = 5 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60_000;

export interface MetadataDocumentClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
}

export type MetadataDocumentResult =
  | { ok: true; client: MetadataDocumentClient }
  | { ok: false; error: string };

type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface MetadataDocumentDeps {
  fetch?: FetchFn;
  lookup?: LookupFn;
  now?: () => number;
  cache?: Map<string, { at: number; client: MetadataDocumentClient }>;
}

const defaultCache = new Map<string, { at: number; client: MetadataDocumentClient }>();

/** A `client_id` that names a metadata document this server is willing to fetch. */
export function isClientIdMetadataUrl(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.pathname === '/' || url.pathname === '') return false;
  if (url.hash || url.username || url.password) return false;
  if (url.port !== '') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) return false;
  return true;
}

function ipv4Public(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** True only for a globally routable unicast address. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return ipv4Public(ip);
  if (family !== 6) return false;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Public(mapped[1]);
  if (lower === '::' || lower === '::1') return false;
  if (/^f[cd]/.test(lower)) return false; // unique local fc00::/7
  if (/^fe[89ab]/.test(lower)) return false; // link-local fe80::/10
  if (/^ff/.test(lower)) return false; // multicast
  return true;
}

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Fetch and validate the metadata document at `clientId`. Only good documents
 * are cached (in process, five minutes), so the consent page's GET and POST
 * fetch once and a fixed document is picked up promptly.
 */
export async function fetchClientMetadataDocument(
  clientId: string,
  deps: MetadataDocumentDeps = {},
): Promise<MetadataDocumentResult> {
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? defaultCache;
  const cached = cache.get(clientId);
  if (cached && now() - cached.at < CACHE_TTL_MS) return { ok: true, client: cached.client };

  if (!isClientIdMetadataUrl(clientId)) return { ok: false, error: 'client_id is not a usable metadata document URL' };
  const url = new URL(clientId);

  const lookup: LookupFn = deps.lookup ?? ((host) => dnsLookup(host, { all: true }));
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname);
  } catch {
    return { ok: false, error: 'client_id host does not resolve' };
  }
  if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
    return { ok: false, error: 'client_id host is not publicly routable' };
  }

  const doFetch: FetchFn = deps.fetch ?? ((u, init) => fetch(u, init));
  let res: Response;
  try {
    res = await doFetch(clientId, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'client metadata document could not be fetched' };
  }
  if (res.status !== 200) return { ok: false, error: `client metadata document returned ${res.status}` };

  const text = await readCapped(res);
  if (text === null) return { ok: false, error: 'client metadata document is too large' };
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    doc = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'client metadata document is not a JSON object' };
  }

  if (doc.client_id !== clientId) return { ok: false, error: 'client metadata document names a different client_id' };
  const redirectUris = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === 'string' && isSafeRedirectUri(u))) {
    return { ok: false, error: 'client metadata document has no usable redirect_uris' };
  }
  const authMethod = doc.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== 'none') {
    return { ok: false, error: 'only public clients (token_endpoint_auth_method "none") are supported' };
  }
  const clientName = typeof doc.client_name === 'string' ? doc.client_name : null;
  if (!reservedNameAllowed(clientName ?? undefined, redirectUris as string[])) {
    return { ok: false, error: 'this app name is reserved for its known redirect hosts' };
  }

  const client: MetadataDocumentClient = { clientId, clientName, redirectUris: redirectUris as string[] };
  cache.set(clientId, { at: now(), client });
  return { ok: true, client };
}
