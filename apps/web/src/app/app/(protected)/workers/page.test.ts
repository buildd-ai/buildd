import { describe, it, expect, mock } from 'bun:test';

/**
 * /app/workers was an orphan: nothing in the app linked to it, and it loaded
 * every worker row (with task and account joins) the user's workspaces had
 * ever run. Workers are viewed on their tasks, so the route now redirects
 * there without touching the database.
 */
const mockRedirect = mock((_url: string): never => { throw new Error('NEXT_REDIRECT'); });
const dbTouched = mock(() => { throw new Error('db must not be touched'); });

mock.module('next/navigation', () => ({ redirect: mockRedirect }));
mock.module('@buildd/core/db', () => ({
  db: new Proxy({}, { get: () => dbTouched }),
}));

import WorkersPage from './page';

describe('/app/workers', () => {
  it('redirects to the task list without querying workers', async () => {
    let redirected = false;
    try {
      await WorkersPage();
    } catch (e: any) {
      if (e?.message === 'NEXT_REDIRECT') redirected = true;
    }
    expect(redirected).toBe(true);
    expect(mockRedirect).toHaveBeenCalledWith('/app/tasks');
    expect(dbTouched).not.toHaveBeenCalled();
  });
});
