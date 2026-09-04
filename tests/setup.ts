// `.env` / `.env.local` set NODE_ENV=development for `bun dev`, and Bun loads
// those files for `bun test` too. That flips on every route's
// `if (process.env.NODE_ENV === 'development')` auth bypass, so "returns 401
// when unauthenticated" assertions fail locally while CI (no .env) passes.
// Pin the ambient value so local and CI runs agree.
process.env.NODE_ENV = 'test';

import { beforeEach, afterEach } from 'bun:test';
import { plugin } from 'bun';

// 'server-only' resolves via its own package.json "exports" condition
// ('react-server' -> no-op, default -> throws); it is not a runtime check.
// Only Next's webpack/turbopack build sets that condition for server-layer
// bundles, so under plain `bun test` any transitive import of it throws
// unconditionally, even from legitimately server-side code (route handlers,
// `@buildd/core/db`). Next's own Jest preset works around this the same way:
// alias the specifier to a no-op module. Mirror that here instead of setting
// `--conditions=react-server` globally, which also swaps React itself to its
// restricted server-components build (no `createContext`) and breaks every
// test that renders through normal React.
plugin({
  name: 'stub-server-only',
  setup(build) {
    build.module('server-only', () => ({ contents: '', loader: 'js' }));
  },
});

const originalConsoleError = console.error;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  console.error = () => {};
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
});
