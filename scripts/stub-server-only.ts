// Stub the `server-only` specifier for the plain Bun runtime.
//
// `packages/core/db/client.ts` imports 'server-only' as a build-time trip wire:
// if a client component ever pulls in the DB layer again, `next build` fails
// loudly instead of shipping a bundle that dies on `dotenv`'s `isTTY` (PR #2072,
// and #1204 before it).
//
// The catch is that 'server-only' is not a runtime check. It resolves through its
// own package.json export conditions — `react-server` -> empty.js, `default` ->
// an index.js whose only statement is a `throw`. Next's bundler is the only thing
// that sets `react-server`, so under `bun run` the default branch always wins and
// any transitive import of the DB layer throws, even from code that is server-side
// by definition: the seed scripts, the backfills, `apps/web/scripts/doctor.ts` and
// the retrieval-eval harness.
//
// Aliasing the specifier to a no-op is what Next's own Jest preset does
// (moduleNameMapper: '^server-only$' -> empty.js). Doing it here, in a Bun
// preload, keeps the trip wire fully intact — a preload only affects the Bun
// runtime and is invisible to the Next bundler that enforces it.
//
// The alternative, `--conditions=react-server`, is a trap: it also swaps React
// itself to the restricted server-components build, which has no `createContext`.
//
// Wired up in `bunfig.toml` (root) and `packages/core/bunfig.toml`; also imported
// by `tests/setup.ts` for `bun test`. Guarded by `scripts/server-only-preload.test.ts`.
import { plugin } from 'bun';

plugin({
  name: 'stub-server-only',
  setup(build) {
    build.module('server-only', () => ({ contents: '', loader: 'js' }));
  },
});

// Runner boot preflight (task c08b35ae). A missing package fails during the
// runner's own module loading, before it can repair anything, and every launcher
// ever written passes this file as --preload, so this is the one hook that
// reaches installs whose launcher predates the repair. It acts only when the
// entry script is the runner's, and does nothing where the file is not checked out.
{
  const entry = process.argv[1] ?? '';
  if (/[\\/]apps[\\/]runner[\\/]src[\\/](index|service)\.ts$/.test(entry)) {
    let preflight: { preflightForEntry: (entry: string) => void } | null = null;
    try { preflight = require('../apps/runner/src/preflight'); } catch { /* not a runner checkout */ }
    preflight?.preflightForEntry(entry);
  }
}
