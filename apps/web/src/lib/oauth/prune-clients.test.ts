import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

let predicate: any;
mock.module('@buildd/core/db', () => ({ db: {
  delete: () => ({ where: (where: unknown) => {
    predicate = where;
    return { returning: async () => [{ clientId: 'unused-client' }] };
  } }),
} }));
import { pruneUnusedClients } from './prune-clients';

describe('unused OAuth client pruning', () => {
  it('only deletes old clients with no grant, authorization code or refresh history', async () => {
    const now = new Date('2026-10-16T00:00:00Z');
    expect(await pruneUnusedClients(now)).toBe(1);
    const { sql, params } = new PgDialect().sqlToQuery(predicate);
    expect(sql).toContain('"oauth_clients"."created_at" <');
    expect(params).toContain('2026-09-16T00:00:00.000Z');
    // Any grant protects the client, including revoked grants. Legacy clients
    // have codes/refresh tokens instead, so those must protect it too.
    for (const table of ['mcp_oauth_grants', 'oauth_codes', 'oauth_refresh_tokens']) {
      expect(sql).toContain(`not exists (select 1 from "${table}"`);
      expect(sql).toContain(`"${table}"."client_id" = "oauth_clients"."client_id"`);
    }
    expect(sql).not.toContain('revoked_at');
    expect(sql).not.toContain('expires_at');
  });
});
