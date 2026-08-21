// `.env` / `.env.local` set NODE_ENV=development for `bun dev`, and Bun loads
// those files for `bun test` too. That flips on every route's
// `if (process.env.NODE_ENV === 'development')` auth bypass, so "returns 401
// when unauthenticated" assertions fail locally while CI (no .env) passes.
// Pin the ambient value so local and CI runs agree.
process.env.NODE_ENV = 'test';

import { beforeEach, afterEach } from 'bun:test';

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
