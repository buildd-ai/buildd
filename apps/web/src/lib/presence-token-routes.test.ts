/**
 * Guard: a person's presence token is accepted by the presence routes and
 * nothing else.
 *
 * `authenticateApiKey` (and so every route built on it, task-token routes
 * included) refuses a `bldp_` token before any lookup (api-auth.test.ts).
 * The only way in is calling `authenticatePresenceToken` /
 * `verifyPresenceTokenSignature` / `revokePresenceToken` directly, so the
 * files that do are pinned here: a new one is a reviewed decision, not a side
 * effect.
 */
import { describe, it, expect } from 'bun:test';
import { execSync } from 'child_process';
import { join } from 'path';

const REPO = join(import.meta.dir, '../../../..');

const ALLOWED = [
  // The token's own module.
  'apps/web/src/lib/presence-token.ts',
  // Presence events: start, touch, bind, end.
  'apps/web/src/app/api/workers/local-sessions/route.ts',
  // The workspace repos the hooks scope against (slugs only).
  'apps/web/src/app/api/workers/local-sessions/workspaces/route.ts',
  // Revoke itself (`buildd logout`).
  'apps/web/src/app/api/auth/presence-token/route.ts',
].sort();

describe('presence token routes', () => {
  it('only the presence routes verify a presence token', () => {
    const out = execSync(
      `git grep -lE "authenticatePresenceToken|verifyPresenceTokenSignature|revokePresenceToken" -- 'apps/web/src' 'packages'`,
      { cwd: REPO, encoding: 'utf8' },
    );
    const files = out.split('\n').filter(Boolean).filter(f => !/\.test\.tsx?$/.test(f)).sort();
    expect(files).toEqual(ALLOWED);
  });
});
