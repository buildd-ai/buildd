import { describe, it, expect } from 'bun:test';
import { buildSkipsTypecheck } from '../../next.config.mjs';

// CI type-checks apps/web in its own job (`next typegen` + `tsc --noEmit` on
// the same tsconfig), so the Next build there need not repeat it. Vercel builds
// only production from `main`, which only takes PRs that passed that job. Local
// `next build` and Vercel preview builds must keep type-checking.
describe('next build type check', () => {
  it('is skipped in GitHub Actions with CI_TYPECHECK_DONE=1', () => {
    expect(buildSkipsTypecheck({ GITHUB_ACTIONS: 'true', CI: 'true', CI_TYPECHECK_DONE: '1' })).toBe(true);
  });

  it('is skipped in Vercel production builds', () => {
    expect(buildSkipsTypecheck({ CI: '1', VERCEL: '1', VERCEL_ENV: 'production' })).toBe(true);
  });

  it('still runs locally, even with the flag set', () => {
    expect(buildSkipsTypecheck({ CI_TYPECHECK_DONE: '1' })).toBe(false);
    expect(buildSkipsTypecheck({ VERCEL_ENV: 'production' })).toBe(false);
    expect(buildSkipsTypecheck({})).toBe(false);
  });

  it('still runs in Vercel preview and development builds', () => {
    expect(buildSkipsTypecheck({ CI: '1', VERCEL: '1', VERCEL_ENV: 'preview' })).toBe(false);
    expect(buildSkipsTypecheck({ CI: '1', VERCEL: '1', VERCEL_ENV: 'development' })).toBe(false);
    expect(buildSkipsTypecheck({ CI: '1', VERCEL: '1', CI_TYPECHECK_DONE: '1' })).toBe(false);
  });

  it('still runs in GitHub Actions without the flag', () => {
    expect(buildSkipsTypecheck({ GITHUB_ACTIONS: 'true', CI: 'true' })).toBe(false);
    expect(buildSkipsTypecheck({ GITHUB_ACTIONS: 'true', CI_TYPECHECK_DONE: 'true' })).toBe(false);
  });
});
