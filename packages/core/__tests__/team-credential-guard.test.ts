import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// Every team read of a label-keyed credential (connector tokens, MCP env
// secrets, role env secrets, webhook signing secrets) must go through
// teamCredentialWhere (packages/core/secrets/team-scope.ts), which excludes
// personal rows. A raw `secrets.label` predicate anywhere else is a lookup that
// can return a personal row sharing the team row's label.

const REPO = join(import.meta.dir, '..', '..', '..');

/** Files that may build these predicates themselves, and why. */
const ALLOWED = new Set([
  'packages/core/secrets/team-scope.ts', // the helper
  'packages/core/secrets/postgres-provider.ts', // exact NULL-aware scope incl. user_id
  'packages/core/inference-keys.ts', // personal-aware resolver: serves a personal row to its owner only
  'apps/web/src/lib/provider-keys.ts', // manages inference keys, scope 'user' | 'team' explicit
  'packages/core/litellm-gateway.ts', // team gateway (inference_key/litellm): isNull(userId) explicit, never personal
  'apps/web/src/lib/litellm-gateway-settings.ts', // manages that team row: isNull(userId) explicit
  'apps/web/src/lib/personal-roles.ts', // personal role env check: eq(userId, owner) explicit, only the owner's rows
]);

/** Call sites that read connector / MCP / role-env / webhook credentials by label or purpose. */
const CALL_SITES = [
  'apps/web/src/app/api/connectors/[id]/disconnect/route.ts',
  'apps/web/src/app/api/connectors/[id]/route.ts',
  'apps/web/src/app/api/connectors/[id]/status/route.ts',
  'apps/web/src/app/api/connectors/[id]/transfer/route.ts',
  'apps/web/src/app/api/connectors/callback/route.ts',
  'apps/web/src/app/api/connectors/route.ts',
  'apps/web/src/app/api/cron/codex-token-refresh/route.ts',
  'apps/web/src/app/api/cron/connector-block-notify/route.ts',
  'apps/web/src/app/api/webhooks/linear/[workspaceId]/route.ts',
  'apps/web/src/app/api/workers/[id]/route.ts',
  'apps/web/src/app/api/workers/claim/connector-gate.ts',
  'apps/web/src/app/api/workers/claim/connector-prefilter.ts',
  'apps/web/src/app/api/workers/claim/credential-injection.ts',
  'apps/web/src/app/api/workers/claim/mcp-connector-injection.ts',
  'apps/web/src/app/api/workers/claim/role-env-injection.ts',
  'apps/web/src/app/api/workspaces/[id]/connectors/route.ts',
  'apps/web/src/app/app/(protected)/home/page.tsx',
  'apps/web/src/lib/connector-queries.ts',
  'apps/web/src/lib/mcp-connector-refresh.ts',
  'apps/web/src/lib/work-tracker.ts',
];

const LABEL_KEYED = 'mcp_connector_credential|mcp_credential|role_env_secret|webhook_token';
const S = String.raw`(?:schema\.)?secrets`;
const RAW_PATTERNS: Array<[string, RegExp]> = [
  ['label predicate', new RegExp(String.raw`\b(?:eq|ne|inArray|notInArray|like|ilike)\(\s*${S}\.label\b`)],
  ['purpose predicate', new RegExp(String.raw`\b(?:eq|ne)\(\s*${S}\.purpose\s*,\s*['"\x60](?:${LABEL_KEYED})['"\x60]`)],
  ['purpose IN list', new RegExp(String.raw`\binArray\(\s*${S}\.purpose\s*,\s*\[[^\]]*['"\x60](?:${LABEL_KEYED})['"\x60]`)],
];

function rawLookups(src: string): string[] {
  return RAW_PATTERNS.filter(([, re]) => re.test(src)).map(([name]) => name);
}

function trackedSources(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'apps', 'packages', 'scripts'], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(p =>
    /\.(ts|tsx)$/.test(p)
    && !/\.test\.tsx?$/.test(p)
    && !p.includes('/__tests__/')
    && !p.includes('/drizzle/')
    && !p.includes('node_modules'),
  );
}

describe('team credential lookups go through teamCredentialWhere', () => {
  it('the pattern catches a raw label lookup (the guard can fail)', () => {
    expect(rawLookups(`and(eq(secrets.teamId, t), eq(secrets.label, id))`)).toContain('label predicate');
    expect(rawLookups(`inArray(\n  secrets.label, ids)`)).toContain('label predicate');
    expect(rawLookups(`where: eq(secrets.purpose, 'mcp_connector_credential')`)).toContain('purpose predicate');
    expect(rawLookups(`inArray(secrets.purpose, ['oauth_token', 'mcp_credential'])`)).toContain('purpose IN list');
    expect(rawLookups(`teamCredentialWhere({ purpose: 'mcp_connector_credential', label: id })`)).toEqual([]);
    expect(rawLookups(`eq(secrets.purpose, 'claude_credential')`)).toEqual([]);
  });

  it('no raw label-keyed secrets lookup exists outside the helper', () => {
    const offenders: string[] = [];
    for (const path of trackedSources()) {
      if (ALLOWED.has(path)) continue;
      const hits = rawLookups(readFileSync(join(REPO, path), 'utf8'));
      if (hits.length > 0) offenders.push(`${path}: ${hits.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  for (const site of CALL_SITES) {
    it(`uses the helper: ${site}`, () => {
      const src = readFileSync(join(REPO, site), 'utf8');
      expect(src).toContain('teamCredentialWhere(');
      expect(src).toContain("from '@buildd/core/secrets/team-scope'");
    });
  }
});
