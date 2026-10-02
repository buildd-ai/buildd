/**
 * Every API route hands the request to API-key auth.
 *
 * `authenticateApiKey(key)` without the request refuses any capability-scoped
 * key (it cannot check the key's scopes against a route it was not told), and
 * Settings only issues scoped keys. Routes that dropped the request broke
 * cloud runs three times: task-token minting, the model endpoint lookup, and
 * parking an evicted run. Mocked-auth route tests never notice, so this checks
 * the call shape across the tree instead.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const API_ROOT = join(import.meta.dir, '..', 'app', 'api');
/**
 * Calls that may omit the request, with why. Keep this short: each entry is a
 * route that cannot hit the scoped-key refusal.
 */
const ALLOWED: Record<string, string> = {
  // An OAuth access token, already verified for this workspace above the
  // call: OAuth sessions carry no key scopes, so nothing is refused.
  'mcp-oauth/[workspace]/route.ts: authenticateApiKey(jwt)': 'verified OAuth JWT',
};

const CALL_WITHOUT_REQUEST = /authenticate(ApiKey|TaskScopedCaller)\(\s*[A-Za-z_$][\w$]*\s*\)/g;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === 'route.ts' ? [p] : [];
  });
}

describe('API routes pass the request to API-key auth', () => {
  it('no route calls authenticateApiKey / authenticateTaskScopedCaller with the key alone', () => {
    const offenders = routeFiles(API_ROOT).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(CALL_WITHOUT_REQUEST)].map((m) => `${relative(API_ROOT, file)}: ${m[0]}`);
    }).filter((o) => !(o in ALLOWED));
    expect(offenders).toEqual([]);
  });

  it('the scan sees the routes (a renamed tree must not make it pass on nothing)', () => {
    expect(routeFiles(API_ROOT).length).toBeGreaterThan(100);
  });
});
