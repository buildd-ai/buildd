import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Invariant: API routes authenticate bearer credentials through the shared
 * helper (`authenticateApiKey`, or `getRequestPrincipal` on top of it), never
 * by looking an account up by its key hash themselves.
 *
 * The helper is the one place that knows every credential shape a caller may
 * present (bld_ keys and OAuth bearer tokens), how each resolves to an account
 * and level, and how the auth caches are kept coherent. A route that hashes
 * the header and queries `accounts` directly silently diverges from all of it.
 */

const WEB_SRC = join(import.meta.dir, '..', '..');
const API_DIR = join(WEB_SRC, 'app', 'api');

/** The helper itself is the only module allowed to read accounts by key hash. */
const ALLOWED = new Set(['lib/api-auth.ts']);

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectSources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** A predicate on the stored key hash — i.e. a lookup, not a write of a new key. */
const KEY_HASH_LOOKUP = /\baccounts\.apiKey\b/;

describe('API key authentication goes through the shared helper', () => {
  it('no module outside the helper looks an account up by key hash', () => {
    const offenders = collectSources(WEB_SRC)
      .map(file => relative(WEB_SRC, file))
      .filter(rel => !ALLOWED.has(rel))
      .filter(rel => KEY_HASH_LOOKUP.test(readFileSync(join(WEB_SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no API route imports hashApiKey unless it mints a key', () => {
    // Minting routes hash a freshly generated plaintext key to store it; that is
    // a write. Anything else importing the hasher under app/api is authenticating
    // by hand.
    const offenders = collectSources(API_DIR)
      .filter(file => {
        const src = readFileSync(file, 'utf8');
        if (!/\bhashApiKey\b/.test(src)) return false;
        return !/hashApiKey\(\s*plaintextKey\s*\)/.test(src);
      })
      .map(file => relative(WEB_SRC, file));
    expect(offenders).toEqual([]);
  });

  it('the scan is live: it sees the helper and the minting routes', () => {
    const all = collectSources(WEB_SRC).map(file => relative(WEB_SRC, file));
    expect(all).toContain('lib/api-auth.ts');
    expect(KEY_HASH_LOOKUP.test(readFileSync(join(WEB_SRC, 'lib/api-auth.ts'), 'utf8'))).toBe(true);
    expect(all.some(f => f.startsWith('app/api/accounts/'))).toBe(true);
  });
});
