/**
 * Policy tokens: the only credential this service knows.
 *
 * A token authorises `resolve` and `outcomes`, nothing else. It is not a
 * buildd key, is never exchanged for one, and there are no provider secrets
 * behind it to export. Rotation: the ring holds `id:token` pairs, so a new
 * token goes in beside the old one before the old one is removed.
 */

export interface PolicyToken {
  id: string;
  token: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
/** A policy token must be long enough to be a secret. */
export const MIN_TOKEN_LENGTH = 24;

/** `id:token[,id:token]`. A malformed entry voids the whole ring: fail closed, never half-configured. */
export function parseTokenRing(raw: string | undefined): PolicyToken[] {
  if (!raw || !raw.trim()) return [];
  const out: PolicyToken[] = [];
  for (const part of raw.split(',')) {
    const at = part.indexOf(':');
    const id = part.slice(0, at).trim();
    const token = part.slice(at + 1).trim();
    if (at < 1 || !ID_RE.test(id) || token.length < MIN_TOKEN_LENGTH) return [];
    out.push({ id, token });
  }
  return out;
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** Compares fixed-length digests in constant time, so timing reveals nothing about a token. */
export async function authenticate(header: string | null, ring: readonly PolicyToken[]): Promise<PolicyToken | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) return null;
  const presented = await digest(m[1]!);
  let found: PolicyToken | null = null;
  for (const entry of ring) {
    const want = await digest(entry.token);
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want[i]! ^ presented[i]!;
    if (diff === 0) found = entry;
  }
  return found;
}
