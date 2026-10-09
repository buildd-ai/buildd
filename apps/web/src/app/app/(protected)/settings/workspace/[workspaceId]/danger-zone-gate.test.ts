/**
 * DELETE /api/workspaces/[id] requires `delete_workspace` (owner only). The
 * danger zone used to render for every role, so admins and members got a
 * Delete button that always failed. page.tsx is a server component that needs
 * a database, so this pins the gate at the source.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

describe('workspace danger zone', () => {
  const idx = PAGE.indexOf('data-testid="workspace-danger-zone"');

  it('exists (the probe can fail)', () => {
    expect(idx).toBeGreaterThan(-1);
  });

  it('is gated on delete_workspace', () => {
    const before = PAGE.slice(0, idx);
    const lastGate = before.lastIndexOf("roleHas(access.role, 'delete_workspace', overrides) && (");
    expect(lastGate).toBeGreaterThan(-1);
    // Nothing between the gate and the section closes the gated expression.
    expect(before.slice(lastGate)).not.toMatch(/\)\}/);
  });
});
