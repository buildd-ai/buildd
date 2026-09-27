import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq, isNull, or } from 'drizzle-orm';
import { secrets } from '../db/schema';

// Rendered with the real dialect, not a mocked db: a mocked db makes the
// predicate unobservable, and the predicate is the whole point here.
import {
  teamCredentialWhere,
  assertPersonalScopeAllowed,
  isPersonalSecretPurpose,
  type TeamCredentialFilter,
} from '../secrets/team-scope';

const dialect = new PgDialect();
function render(frag: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(frag as never);
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
}

const PERSONAL_GUARD = '("secrets"."user_id" is null and ';

// One row per lookup shape used by a call site (see team-credential-guard.test.ts
// for the list of files). Each must exclude personal rows as the OUTERMOST
// conjunct: a personal row with the same team, purpose and label as the team
// row then cannot satisfy the predicate, whatever else the caller adds.
const CASES: Array<{ site: string; filter: TeamCredentialFilter; extra?: ReturnType<typeof eq>[] }> = [
  { site: 'connector status / callback / header upsert / delete / disconnect / work tracker',
    filter: { teamId: 't-1', purpose: 'mcp_connector_credential', label: 'conn-1' } },
  { site: 'claim injection, gate and pre-filter, connectors list (owner teams)',
    filter: { teamId: ['t-1', 't-2'], purpose: 'mcp_connector_credential', label: ['conn-1', 'conn-2'] } },
  { site: 'connector transfer (credential + refresh label)',
    filter: { teamId: 't-1', purpose: 'mcp_connector_credential', label: ['conn-1', 'conn-1:refresh'] } },
  { site: 'workspace connectors / home page / connector queries (no label)',
    filter: { teamId: ['t-1'], purpose: 'mcp_connector_credential' } },
  { site: 'refresh + block-notify crons (cross-team sweep)',
    filter: { purpose: 'mcp_connector_credential' } },
  { site: 'mid-task 401/403 report (by label)',
    filter: { purpose: 'mcp_connector_credential', label: 'conn-1' } },
  { site: 'stdio MCP env secrets (claim, gate, pre-filter, transfer)',
    filter: { teamId: ['t-1'], purpose: 'mcp_credential', label: ['GITHUB_TOKEN'] } },
  { site: 'role env secrets', filter: { teamId: 't-1', purpose: 'role_env_secret', label: ['NPM_TOKEN'] },
    extra: [or(isNull(secrets.accountId), eq(secrets.accountId, 'a-1'))!] },
  { site: 'claim credential injection', filter: { teamId: 't-1', purpose: ['anthropic_api_key', 'oauth_token', 'mcp_credential'] },
    extra: [or(isNull(secrets.workspaceId), eq(secrets.workspaceId, 'w-1'))!] },
  { site: 'linear webhook signing secret', filter: { purpose: 'webhook_token', label: 'linear' },
    extra: [eq(secrets.workspaceId, 'w-1')] },
];

describe('teamCredentialWhere', () => {
  for (const c of CASES) {
    it(`excludes personal rows as the outermost conjunct: ${c.site}`, () => {
      const { sql } = render(teamCredentialWhere(c.filter, ...(c.extra ?? [])));
      expect(sql.startsWith(PERSONAL_GUARD)).toBe(true);
      expect(sql).not.toContain('"secrets"."user_id" =');
    });
  }

  it('an OR supplied by the caller stays inside the guarded conjunction', () => {
    const { sql } = render(teamCredentialWhere(
      { teamId: 't-1', purpose: 'mcp_connector_credential', label: 'conn-1' },
      or(eq(secrets.label, 'conn-1'), isNull(secrets.label)),
    ));
    expect(sql.startsWith(PERSONAL_GUARD)).toBe(true);
    // The OR is parenthesised on its own, so it cannot absorb the guard.
    expect(sql).toContain('and ("secrets"."label" = $4 or "secrets"."label" is null))');
  });

  it('keeps the team, purpose, label parameter order the claim tests pin', () => {
    const { params, sql } = render(teamCredentialWhere({ teamId: 't-1', purpose: 'mcp_connector_credential', label: 'conn-1' }));
    expect(params).toEqual(['t-1', 'mcp_connector_credential', 'conn-1']);
    expect(sql).toContain('"secrets"."team_id" = $1');
    expect(sql).toContain('"secrets"."purpose" = $2');
    expect(sql).toContain('"secrets"."label" = $3');
  });

  it('renders arrays as IN lists', () => {
    const { sql } = render(teamCredentialWhere({ teamId: ['t-1', 't-2'], purpose: ['mcp_credential'], label: ['A', 'B'] }));
    expect(sql).toContain('"secrets"."team_id" in ($1, $2)');
    expect(sql).toContain('"secrets"."purpose" in ($3)');
    expect(sql).toContain('"secrets"."label" in ($4, $5)');
  });
});

describe('personal-scope write guard', () => {
  it('only inference keys and personal Pushover keys are personal', () => {
    expect(isPersonalSecretPurpose('inference_key')).toBe(true);
    expect(isPersonalSecretPurpose('pushover_personal')).toBe(true);
    // The TEAM Pushover channel stays team-only: a personal away-alert must
    // never be able to resolve to it, and a team read of it never sees a person's row.
    for (const p of ['pushover', 'notify_webhook', 'mcp_connector_credential', 'mcp_credential', 'role_env_secret', 'oauth_token', 'anthropic_api_key', 'decision_key']) {
      expect(isPersonalSecretPurpose(p)).toBe(false);
    }
  });

  it('refuses a userId on a connector or MCP credential', () => {
    expect(() => assertPersonalScopeAllowed('mcp_connector_credential', 'u-1')).toThrow();
    expect(() => assertPersonalScopeAllowed('mcp_credential', 'u-1')).toThrow();
    expect(() => assertPersonalScopeAllowed('role_env_secret', 'u-1')).toThrow();
    expect(() => assertPersonalScopeAllowed(undefined, 'u-1')).toThrow();
  });

  it('refuses a userId on the team Pushover channel', () => {
    expect(() => assertPersonalScopeAllowed('pushover', 'u-1')).toThrow();
  });

  it('allows team rows for any purpose and personal rows for inference keys', () => {
    expect(() => assertPersonalScopeAllowed('mcp_connector_credential', null)).not.toThrow();
    expect(() => assertPersonalScopeAllowed('mcp_credential', undefined)).not.toThrow();
    expect(() => assertPersonalScopeAllowed('inference_key', 'u-1')).not.toThrow();
    expect(() => assertPersonalScopeAllowed('pushover_personal', 'u-1')).not.toThrow();
  });
});

describe('PostgresSecretsProvider refuses personal rows for team purposes', () => {
  // The assertion runs before encryption or any query, so no db is needed.
  it('replaceScoped throws for a userId-scoped connector credential', async () => {
    const { PostgresSecretsProvider } = await import('../secrets/postgres-provider');
    const p = new PostgresSecretsProvider();
    await expect(p.replaceScoped('v', { teamId: 't-1', purpose: 'mcp_connector_credential', label: 'c', userId: 'u-1' }))
      .rejects.toThrow(/personal/);
  });

  it('set (insert) throws for a userId-scoped MCP credential', async () => {
    const { PostgresSecretsProvider } = await import('../secrets/postgres-provider');
    const p = new PostgresSecretsProvider();
    await expect(p.set(null, 'v', { teamId: 't-1', purpose: 'mcp_credential', label: 'X', userId: 'u-1' }))
      .rejects.toThrow(/personal/);
  });
});
