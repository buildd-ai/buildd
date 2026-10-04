/**
 * Regression guard: seed-role-mcps.ts must not write the retired planner MCP
 * endpoint back into role rows. That hostname now serves a different service
 * and answers 404 on /api/mcp, so a re-seed would silently break every role it
 * touches. The planner MCP is the Cue endpoint (owned by seed-cue-connector.ts)
 * and authenticates the shared key with a tenant header.
 *
 * The script runs its side effects at module scope (DB client, required env),
 * so this reads its source rather than importing it.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(import.meta.dir, '../scripts/seed-role-mcps.ts'), 'utf8');

describe('seed-role-mcps planner MCP entry', () => {
  it('never references the retired dispatch.buildd.dev endpoint', () => {
    expect(src).not.toContain('dispatch.buildd.dev');
  });

  it('takes the planner URL from the Cue connector seed, not a literal', () => {
    expect(src).toMatch(/import\s*\{[^}]*CUE_CONNECTOR_URL[^}]*\}\s*from\s*'\.\/seed-cue-connector'/);
    expect(src).toMatch(/url:\s*CUE_CONNECTOR_URL/);
  });

  it('sends the tenant header the Cue MCP requires with the shared key', () => {
    expect(src).toContain("'x-tenant-id': '${TENANT_ID}'");
  });
});
