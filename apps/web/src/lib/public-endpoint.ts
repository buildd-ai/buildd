/**
 * SSRF guard for server-side fetches of tenant-supplied URLs: https only, no
 * embedded credentials, and every resolved address public. Shared by the
 * evidence backend endpoint check and the connector icon fetcher.
 */
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export type ResolveHost = (hostname: string) => Promise<string[]>;

export const defaultResolveHost: ResolveHost = async (hostname) => {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map(f => f.address);
};

function isBlockedIpv4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224; // multicast, reserved, broadcast
}

/** Eight 16-bit groups of an IPv6 literal, or null when it does not parse. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (isIP(dotted[2]) !== 4) return null;
    const [a, b, c, d] = dotted[2].split('.').map(Number);
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for a loopback, private, link-local, multicast or otherwise non-public address. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.every(x => x === 0)) return true; // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isBlockedIpv4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return isBlockedIpv4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedIpv4(embeddedV4(g[1], g[2])); // 6to4
  return false;
}

export type EndpointCheck = { ok: true } | { ok: false; error: string };

/**
 * A tenant-supplied endpoint must be https, carry no credentials, and resolve
 * only to public addresses. Check again right before each connection (DNS can
 * change), so a hostname that later points inward is refused too.
 */
export async function validatePublicEndpoint(endpoint: string, resolveHost: ResolveHost = defaultResolveHost): Promise<EndpointCheck> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: 'endpoint must be a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'endpoint must use https' };
  if (url.username || url.password) return { ok: false, error: 'endpoint must not contain credentials' };

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, error: 'endpoint has no host' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: 'endpoint must not point at a private or link-local address' };
  }

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolveHost(host);
    } catch {
      return { ok: false, error: `endpoint host "${host}" could not be resolved` };
    }
    if (addresses.length === 0) return { ok: false, error: `endpoint host "${host}" could not be resolved` };
  }
  if (addresses.some(isBlockedAddress)) {
    return { ok: false, error: 'endpoint must not point at a private or link-local address' };
  }
  return { ok: true };
}
