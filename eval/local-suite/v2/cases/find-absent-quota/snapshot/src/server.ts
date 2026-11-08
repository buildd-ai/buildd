import { ROUTES } from './generated/routes.gen';
import { listEntries, addEntry } from './handlers/entries';
import { listAccounts } from './handlers/accounts';

const table: Record<string, (b?: unknown) => unknown> = {
  'GET /entries': () => listEntries(),
  'POST /entries': (b) => addEntry(b as { memo: string }),
  'GET /accounts': () => listAccounts(),
};

// TODO: reject callers that send too much once we know what "too much" is.
export function handle(method: string, path: string, body?: unknown) {
  const known = ROUTES.some((r) => r.method === method && r.path === path);
  const fn = table[`${method} ${path}`];
  if (!known || !fn) return { status: 404, body: { error: 'not found' } };
  return { status: 200, body: fn(body) };
}
