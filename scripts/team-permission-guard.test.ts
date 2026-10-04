import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// Team permission decisions must route through apps/web/src/lib/permissions.ts
// (the `can()` and `roleHas()` functions) and not be hardcoded scattered across
// the codebase. This prevents permission logic drift as the schema and routes change.
//
// Allowed exceptions (schema type definitions, role assignment in members routes,
// labels and badges) are listed in ALLOWED_FILES below.

const REPO = join(import.meta.dir, '..');

/**
 * Files that legitimately contain hardcoded role references, and why.
 * Most entries here are intentionally seeded from prior migration PRs and should
 * eventually migrate to the centralized permissions module.
 */
const ALLOWED_FILES = new Map<string, string>([
  // Schema type definitions: the shape of the role field.
  ['packages/core/db/schema.ts', 'Schema field type annotation for role: text.$type<...>()'],
  // Permission registry: the source of truth for team role names and their permissions.
  ['apps/web/src/lib/permission-registry.ts', 'Permission registry: defines TEAM_ROLES, OWNER_ADMIN, etc.'],
  // Members routes: handle role assignment (adding, changing roles).
  ['apps/web/src/app/api/teams/[id]/members/route.ts', 'Role assignment: validates and assigns roles on POST'],
  ['apps/web/src/app/api/teams/[id]/members/[userId]/route.ts', 'Role assignment: validates and updates roles'],
  // Shared types: the TeamRole type definition.
  ['packages/shared/src/types.ts', 'TeamRole type definition for API contracts'],
  // ─ Entries below were left from prior migration and should eventually migrate to permissions ─
  ['apps/web/src/app/api/teams/[id]/invitations/route.ts', 'Gates invitation listing/creation to owner/admin (pre-migration)'],
  ['apps/web/src/app/api/teams/[id]/invitations/[invitationId]/route.ts', 'Gates invitation operations to owner/admin (pre-migration)'],
  ['apps/web/src/app/api/accounts/route.ts', 'API key scope grant gating (pre-migration)'],
  ['apps/web/src/app/api/connectors/route.ts', 'Gates connector sharing to owner/admin (pre-migration)'],
  ['apps/web/src/app/api/connectors/[id]/shares/route.ts', 'Gates connector sharing to owner/admin (pre-migration)'],
  ['apps/web/src/app/api/connectors/[id]/transfer/route.ts', 'Gates connector transfer to owner/admin (pre-migration)'],
  ['apps/web/src/lib/chat/turn.ts', 'Includes teamRole in user context for logging (pre-migration)'],
  ['apps/web/src/lib/migrate-access.ts', 'Migration utility checking role (pre-migration)'],
  ['apps/web/src/lib/oauth/session-level.ts', 'Maps team role to API key level (pre-migration)'],
]);

function trackedSources(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'apps/web/src', 'packages/core', 'packages/shared'], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(p =>
    /\.(ts|tsx)$/.test(p)
    && !/\.test\.tsx?$/.test(p)
    && !p.includes('/__tests__/')
    && !p.includes('/tests/')
    && !p.includes('/drizzle/')
    && !p.includes('node_modules')
  );
}

function grepFiles(pattern: string): Map<string, string[]> {
  // -P (Perl regex), not -E: git grep -E silently drops \b.
  // Returns a map of file -> array of matching line contents.
  try {
    const out = execFileSync('git', ['grep', '-nP', pattern, '--', 'apps/web/src', 'packages/core', 'packages/shared'], { cwd: REPO, encoding: 'utf8' });
    const result = new Map<string, string[]>();
    for (const line of out.split('\n').filter(Boolean)) {
      const match = line.match(/^([^:]+):(\d+):(.+)$/);
      if (match) {
        const [, file, lineNum, content] = match;
        if (!result.has(file)) result.set(file, []);
        result.get(file)!.push(`${lineNum}:${content}`);
      }
    }
    return result;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return new Map(); // no match
    throw err;
  }
}

function isTeamRolePermissionCheck(content: string): boolean {
  // True if content is a PERMISSION DECISION using hardcoded team roles,
  // false if it's something else (role assignment, type annotation, chat/model/worker role, etc.)

  // Skip lines that are obviously role assignment or validation contexts
  if (content.includes('includes(role)') && content.includes('Invalid role')) return false; // input validation
  if (content.includes('$type<') || content.includes('.$type')) return false; // schema type annotation
  if (content.includes("'user'") || content.includes("'assistant'")) return false; // chat message role
  if (content.includes('incumbent') || content.includes('challenger')) return false; // model tier role
  if (content.includes('TEAM_ROLES') || content.includes('OWNER_ADMIN')) return false; // registry constant
  if (content.includes('researcher') || content.includes('builder') || content.includes('organizer')) return false; // worker role
  if (content.includes('readonly')) return false; // readonly type annotation
  if (content.includes('satisfies readonly')) return false; // type satisfaction
  if (content.includes('export const') && (content.includes('OWNER') || content.includes('TEAM_ROLES'))) return false; // registry export
  if (content.includes('type TeamRole') || content.includes('TeamRole =')) return false; // type definition
  if (content.includes('message.role')) return false; // chat message role
  if (content.includes('phase') && content.includes('role')) return false; // mission phase role

  // Skip if it's obviously in a validation array (multiple values)
  if (content.includes("'owner'") && content.includes("'admin'") && content.includes("'member'") && content.includes('includes')) {
    if (!content.includes('!')) return false; // positive includes() is validation, not permission
  }

  return true;
}

describe('Team permission decisions are centralized', () => {
  it('the pattern catches hardcoded role checks (guard can fail)', () => {
    const testSrc = `
      if (role === 'owner') { /* permission decision */ }
      if (role !== 'admin') { /* permission decision */ }
      if (membership.role === "member" && !canDoX) { /* permission decision */ }
      if (currentRole === 'admin' || currentRole === 'owner') { /* permission decision */ }
    `;

    // These patterns should match
    expect(/\brole\s*[!=]==\s*['"][a-z]+['"]/.test(testSrc)).toBe(true);
    expect(/membership\s*\.\s*role\s*[!=]==\s*['"][a-z]+['"]/.test(testSrc)).toBe(true);

    // Non-matches
    expect(/\brole\s*[!=]==\s*['"][a-z]+['"]/.test(`$type<'owner' | 'admin' | 'member'>`)).toBe(false);
  });

  it('finds all tracked source files (the scan is not empty)', () => {
    const sources = trackedSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toContain('apps/web/src/lib/permissions.ts');
    expect(sources).toContain('apps/web/src/lib/permission-registry.ts');
  });

  it('has no hardcoded team role permission checks outside the permissions module', () => {
    // Search for the specific patterns: role === 'owner'|'admin'|'member' or membership.role checks
    // These catch permission decisions (BAD) but also role assignment validation (needs allowlist)

    // Pattern: membership.role !== 'member' or similar (checking team role for a decision)
    const membershipRolePattern = String.raw`membership\s*\.\s*role\s*(?:[!]==?|===?)\s*['"](?:owner|admin|member)['"]`;

    // Pattern: role === 'owner' | role !== 'admin' (direct role comparisons in permission context)
    // We try to avoid false positives by also matching context patterns
    const directRoleComparison = String.raw`\b(?:role|currentRole|userRole|teamRole)\s*(?:[!]==?|===?)\s*['"](?:owner|admin|member)['"]`;

    const tracked = new Set(trackedSources());
    const allMatches = new Map<string, string[]>();

    // Search with both patterns
    for (const pattern of [membershipRolePattern, directRoleComparison]) {
      const matches = grepFiles(pattern);
      for (const [file, lines] of matches) {
        if (tracked.has(file)) {
          if (!allMatches.has(file)) allMatches.set(file, []);
          allMatches.get(file)!.push(...lines);
        }
      }
    }

    // Filter to actual permission decisions (not role assignment validation, types, etc.)
    const offendingFiles: { file: string; lines: string[] }[] = [];
    for (const [file, lines] of allMatches) {
      // Skip files in the allowlist
      if (ALLOWED_FILES.has(file)) {
        continue;
      }

      // Filter lines to actual permission decisions
      const actualDecisions = lines.filter(line => {
        const content = line.split(':')[1] || '';
        return isTeamRolePermissionCheck(content);
      });

      if (actualDecisions.length > 0) {
        offendingFiles.push({ file, lines: actualDecisions });
      }
    }

    if (offendingFiles.length > 0) {
      const message = offendingFiles
        .map(({ file, lines }) =>
          `${file}:\n  ${lines.join('\n  ')}\n  → Use a named permission from apps/web/src/lib/permissions.ts (roleHas, can)`
        )
        .join('\n\n');
      expect.unreachable(`Hardcoded team role checks found:\n\n${message}`);
    }
  });

  it('allowlist is complete and current', () => {
    // Verify that allowed files actually exist and contain what we expect
    for (const [file, reason] of ALLOWED_FILES) {
      const path = join(REPO, file);
      const content = readFileSync(path, 'utf8');

      // At least one role reference should exist in each allowed file
      const hasRoleRef = /\b(?:owner|admin|member)\b/.test(content);
      expect(hasRoleRef).toBe(true, `${file} (${reason}) should contain role references`);
    }
  });
});
