/**
 * Which addresses a server-side verification request may reach.
 *
 * Invariant: a verification call made on a user's behalf (an agent model
 * endpoint, a LiteLLM gateway) reaches only public internet addresses, never
 * follows a redirect, and is judged on every address its host resolves to.
 * The loopback names are allowed only outside production, for local
 * development against a proxy on the same machine.
 *
 * Pure except for the default DNS lookup, which is imported lazily so this
 * file loads anywhere (the runner, a plain bun test).
 */

/** Hosts plain http and loopback are allowed for, outside production only. */
export const LOCAL_DEV_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** True when the loopback dev hosts may be used (NODE_ENV is not `production`). */
export function localDevHostsAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

// ── Address classification ────────────────────────────────────────────────────

function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Eight 16-bit groups, or null. Accepts an embedded dotted IPv4 tail and a zone id. */
function parseIPv6(raw: string): number[] | null {
  let s = raw.replace(/%.*$/, '').toLowerCase();
  if (!s.includes(':')) return null;
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (h: string) => (h === '' ? [] : h.split(':'));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  for (const g of [...head, ...rest]) if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  const have = head.length + rest.length;
  if (halves.length === 1 && have !== 8) return null;
  if (halves.length === 2 && have > 7) return null;
  const zeros = halves.length === 2 ? 8 - have : 0;
  return [...head, ...Array<string>(zeros).fill('0'), ...rest].map(g => parseInt(g, 16));
}

function inV4(a: number[], base: number[], bits: number): boolean {
  const toInt = (x: number[]) => ((x[0] << 24) >>> 0) + (x[1] << 16) + (x[2] << 8) + x[3];
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((toInt(a) & mask) >>> 0) === ((toInt(base) & mask) >>> 0);
}

/** Special-purpose IPv4 space (RFC 6890 and friends) that is not the public internet. */
const NON_PUBLIC_V4: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8],        // "this network"
  [[10, 0, 0, 0], 8],       // RFC 1918
  [[100, 64, 0, 0], 10],    // CGNAT
  [[127, 0, 0, 0], 8],      // loopback
  [[169, 254, 0, 0], 16],   // link-local (incl. cloud metadata)
  [[172, 16, 0, 0], 12],    // RFC 1918
  [[192, 0, 0, 0], 24],     // IETF protocol assignments
  [[192, 0, 2, 0], 24],     // documentation
  [[192, 88, 99, 0], 24],   // 6to4 relay anycast
  [[192, 168, 0, 0], 16],   // RFC 1918
  [[198, 18, 0, 0], 15],    // benchmarking
  [[198, 51, 100, 0], 24],  // documentation
  [[203, 0, 113, 0], 24],   // documentation
  [[224, 0, 0, 0], 4],      // multicast
  [[240, 0, 0, 0], 4],      // reserved, incl. broadcast
];

function isPublicV4(a: number[]): boolean {
  return !NON_PUBLIC_V4.some(([base, bits]) => inV4(a, base, bits));
}

function isPublicV6(g: number[]): boolean {
  const v4At = (i: number) => [g[i] >> 8, g[i] & 0xff, g[i + 1] >> 8, g[i + 1] & 0xff];
  // ::/96: unspecified, loopback and the deprecated IPv4-compatible form.
  if (g.slice(0, 6).every(x => x === 0)) return false;
  // ::ffff:0:0/96 IPv4-mapped, and 64:ff9b::/96 NAT64: judge the embedded IPv4.
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return isPublicV4(v4At(6));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isPublicV4(v4At(6));
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false;        // 64:ff9b:1::/48 local NAT64
  if (g[0] === 0x2002) return isPublicV4(v4At(1));                          // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return false;                          // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;                     // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every(x => x === 0)) return false;   // discard
  if ((g[0] & 0xfe00) === 0xfc00) return false;                             // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false;                             // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return false;                             // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false;                             // multicast
  return true;
}

/**
 * True only for a well-formed IP address on the public internet. Anything
 * else, including a hostname or a malformed literal, is false.
 */
export function isPublicAddress(ip: string): boolean {
  const s = ip.replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(s);
  if (v4) return isPublicV4(v4);
  const v6 = parseIPv6(s);
  if (v6) return isPublicV6(v6);
  return false;
}

/** True for an IPv4 or IPv6 literal (brackets allowed), public or not. */
export function isIpLiteral(host: string): boolean {
  const s = host.replace(/^\[|\]$/g, '');
  return parseIPv4(s) !== null || (s.includes(':') && parseIPv6(s) !== null);
}

// ── Host check ────────────────────────────────────────────────────────────────

export type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupAll = async (hostname) => {
  const dns = await import('node:dns/promises');
  return dns.lookup(hostname, { all: true, verbatim: true });
};

export const HOST_NOT_PUBLIC = 'the endpoint host is not a public address';
export const HOST_UNRESOLVED = 'the endpoint host could not be resolved';
const NOT_PUBLIC = HOST_NOT_PUBLIC;

/**
 * Null when `hostname` (a URL's `hostname`, brackets allowed) may be reached:
 * every address it resolves to is public. An IP literal is judged as is.
 * With `allowLocal`, LOCAL_DEV_HOSTS pass. Error text is fixed: it never
 * carries a resolver message or a resolved address.
 */
export async function checkPublicHost(
  hostname: string,
  opts: { lookup?: LookupAll; allowLocal?: boolean } = {},
): Promise<string | null> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (opts.allowLocal && LOCAL_DEV_HOSTS.includes(host)) return null;
  if (isIpLiteral(host)) return isPublicAddress(host) ? null : NOT_PUBLIC;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await (opts.lookup ?? defaultLookup)(host);
  } catch {
    return HOST_UNRESOLVED;
  }
  if (addrs.length === 0 || !addrs.every(a => isPublicAddress(a.address))) return NOT_PUBLIC;
  return null;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export class NonPublicAddressError extends Error {
  /** True when the host did not resolve (possibly transient), not when it resolved somewhere non-public. */
  readonly unresolved: boolean;
  constructor(message: string) { super(message); this.name = 'NonPublicAddressError'; this.unresolved = message === HOST_UNRESOLVED; }
}

export class RedirectRefusedError extends Error {
  constructor(readonly status: number) { super('the endpoint answered with a redirect, which is not followed'); this.name = 'RedirectRefusedError'; }
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * `fetch` for a verification call: the host is checked with checkPublicHost
 * first (NonPublicAddressError, nothing sent), redirects are never followed
 * (`redirect: 'manual'`), and any 3xx answer is a RedirectRefusedError.
 */
export async function fetchPublicNoRedirect(
  url: string,
  init: RequestInit,
  opts: { fetcher?: Fetcher; lookup?: LookupAll; allowLocal?: boolean } = {},
): Promise<Response> {
  const problem = await checkPublicHost(new URL(url).hostname, { lookup: opts.lookup, allowLocal: opts.allowLocal });
  if (problem) throw new NonPublicAddressError(problem);
  const res = await (opts.fetcher ?? ((u, i) => fetch(u, i)))(url, { ...init, redirect: 'manual' });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    throw new RedirectRefusedError(res.status);
  }
  return res;
}

// ── Verification call ─────────────────────────────────────────────────────────

export interface VerifyOutcome {
  health: 'healthy' | 'revoked' | 'unknown';
  /** Fixed text plus at most a status code. Never response-body text, a resolver message or an address. */
  error: string | null;
  /** The URL itself may not be used (a non-public host or a redirect): a settings save refuses it. */
  blocked?: true;
}

/**
 * One verification request through fetchPublicNoRedirect. 2xx ⇒ healthy,
 * 401/403 ⇒ revoked, any other status or a network failure ⇒ unknown (an
 * outage never marks a credential dead). The response body is never read.
 * `label` names the thing in the error ("endpoint", "gateway").
 * `classify` may claim a non-2xx status first (status only, never the body);
 * returning null falls through to the default mapping.
 */
export async function verifyByFetch(
  label: string,
  url: string,
  init: RequestInit,
  opts: { fetcher?: Fetcher; lookup?: LookupAll; allowLocal?: boolean; classify?: (status: number) => VerifyOutcome | null } = {},
): Promise<VerifyOutcome> {
  let res: Response;
  try {
    res = await fetchPublicNoRedirect(url, init, { fetcher: opts.fetcher, lookup: opts.lookup, allowLocal: opts.allowLocal ?? localDevHostsAllowed() });
  } catch (e) {
    if (e instanceof NonPublicAddressError) {
      return e.unresolved
        ? { health: 'unknown', error: `the ${label} host could not be resolved` }
        : { health: 'unknown', error: `the ${label} host is not a public address`, blocked: true };
    }
    if (e instanceof RedirectRefusedError) {
      return { health: 'unknown', error: `${label} answered with a redirect${e.status ? ` (${e.status})` : ''}, which is not followed`, blocked: true };
    }
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { health: 'unknown', error: `could not reach the ${label}${timedOut ? ' (timed out)' : ''}` };
  }
  await res.body?.cancel().catch(() => {});
  if (res.ok) return { health: 'healthy', error: null };
  const claimed = opts.classify?.(res.status);
  if (claimed) return claimed;
  if (res.status === 401 || res.status === 403) return { health: 'revoked', error: `${label} rejected the key (${res.status})` };
  return { health: 'unknown', error: `${label} returned ${res.status}` };
}
