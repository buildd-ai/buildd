/**
 * The artifact page's Content-Security-Policy (next.config.mjs, artifactPageCsp):
 * `frame-src` is the storage origin and nothing else, set on /app/artifacts/[id]
 * only. No other page carries a CSP today.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/artifact-page-csp.test.ts
 */
import { describe, expect, it } from 'bun:test';
import nextConfig, { artifactPageCsp, DESIGN_FRAMING_SOURCES } from '../../next.config.mjs';

describe('artifactPageCsp', () => {
  it('allows frames from the storage origin only, dropping the bucket path', () => {
    expect(artifactPageCsp('https://acct.r2.cloudflarestorage.com/buildd-artifacts')).toBe('frame-src https://acct.r2.cloudflarestorage.com');
    expect(artifactPageCsp('http://localhost:9000')).toBe('frame-src http://localhost:9000');
  });

  it('frames nothing when storage is unset or not a URL', () => {
    expect(artifactPageCsp(undefined)).toBe("frame-src 'none'");
    expect(artifactPageCsp('')).toBe("frame-src 'none'");
    expect(artifactPageCsp('not a url')).toBe("frame-src 'none'");
    expect(artifactPageCsp('ftp://x.example')).toBe("frame-src 'none'");
  });

  it('never widens to self, data: or a wildcard', () => {
    const csp = artifactPageCsp('https://acct.r2.cloudflarestorage.com');
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain('data:');
    expect(csp).not.toContain('*');
    expect(csp.split(';').length).toBe(1);
  });
});

describe('next.config headers', () => {
  it('sets the CSP on the artifact page and the mission, task and spec pages, nowhere else', async () => {
    const headers = await nextConfig.headers!();
    const withCsp = headers.filter((h) => h.headers.some((x) => x.key === 'Content-Security-Policy'));
    expect(withCsp.map((h) => h.source)).toEqual(['/app/artifacts/:id', ...DESIGN_FRAMING_SOURCES]);
    expect(DESIGN_FRAMING_SOURCES).toEqual(['/app/missions/:id', '/app/tasks/:id', '/app/specs/:specId']);
    for (const h of withCsp) {
      const value = h.headers.find((x) => x.key === 'Content-Security-Policy')!.value;
      expect(value.startsWith('frame-src ')).toBe(true);
    }
  });
});
