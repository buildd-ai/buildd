import { describe, expect, it } from 'bun:test';

// Regression guard: `.env`/`.env.local` set NODE_ENV=development and Bun loads
// them for `bun test`, which turns on the dev auth bypass in every route that
// checks `process.env.NODE_ENV === 'development'`. That made ~6 route test
// files fail locally while passing in CI. tests/setup.ts pins the value; this
// fails if that pin is ever removed.
describe('test environment', () => {
  it('does not run the suite in development mode', () => {
    expect(process.env.NODE_ENV).not.toBe('development');
  });
});
