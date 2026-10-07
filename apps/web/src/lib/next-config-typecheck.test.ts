import { describe, it, expect } from 'bun:test';
import { buildSkipsTypecheck } from '../../next.config.mjs';

// CI type-checks apps/web in its own job (`next typegen` + `tsc --noEmit` on
// the same tsconfig), so the Next build there need not repeat it. Everywhere
// else — local `next build`, Vercel — the build must keep type-checking.
describe('next build type check', () => {
  it('is skipped only in GitHub Actions with CI_TYPECHECK_DONE=1', () => {
    expect(buildSkipsTypecheck({ GITHUB_ACTIONS: 'true', CI: 'true', CI_TYPECHECK_DONE: '1' })).toBe(true);
  });

  it('still runs locally, even with the flag set', () => {
    expect(buildSkipsTypecheck({ CI_TYPECHECK_DONE: '1' })).toBe(false);
    expect(buildSkipsTypecheck({})).toBe(false);
  });

  it('still runs on Vercel, which sets CI but not GITHUB_ACTIONS', () => {
    expect(buildSkipsTypecheck({ CI: '1', VERCEL: '1', CI_TYPECHECK_DONE: '1' })).toBe(false);
  });

  it('still runs in GitHub Actions without the flag', () => {
    expect(buildSkipsTypecheck({ GITHUB_ACTIONS: 'true', CI: 'true' })).toBe(false);
    expect(buildSkipsTypecheck({ GITHUB_ACTIONS: 'true', CI_TYPECHECK_DONE: 'true' })).toBe(false);
  });
});
