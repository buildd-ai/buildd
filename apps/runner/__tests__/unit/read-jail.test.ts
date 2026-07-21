/**
 * Regression tests for Tier-2 read-jail confinement (read-jail.ts).
 *
 * Verifies that isPathDeniedByReadJail() correctly allows reads inside the
 * worker's worktree and denies reads to:
 *   - Sibling worktrees (other tenants' code)
 *   - ~/.buildd/ (runner API key + worker-state files)
 *   - $TMPDIR/buildd-codex-homes/<id>/auth.json (Codex credential homes)
 *   - $TMPDIR/claude-cfg-XXXXXX/ (per-worker Claude credential dirs)
 *
 * Run: bun test apps/runner/__tests__/unit/read-jail.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { normalize, join } from 'path';
import {
  buildReadJailDeniedPrefixes,
  isPathDeniedByReadJail,
  resolveToolPath,
  CLAUDE_CFG_TMP_PREFIX,
} from '../../src/read-jail';

const HOME = homedir();
const TMP = tmpdir();

// Simulated repo / worktree layout
const REPO_PATH = '/home/coder/.buildd/repos/myorg/myrepo';
const WORKTREE = `${REPO_PATH}/.buildd-worktrees/buildd_abc123-my-feature`;
const SIBLING_WORKTREE = `${REPO_PATH}/.buildd-worktrees/buildd_def456-other-branch`;
const DENIED = buildReadJailDeniedPrefixes(REPO_PATH);

describe('buildReadJailDeniedPrefixes', () => {
  test('includes ~/.buildd', () => {
    expect(DENIED).toContain(normalize(`${HOME}/.buildd`));
  });

  test('includes repo/.buildd-worktrees', () => {
    expect(DENIED).toContain(normalize(`${REPO_PATH}/.buildd-worktrees`));
  });

  test('includes $TMPDIR/buildd-codex-homes', () => {
    expect(DENIED).toContain(normalize(`${TMP}/buildd-codex-homes`));
  });
});

describe('isPathDeniedByReadJail — own worktree (always allowed)', () => {
  test('worktree root is allowed', () => {
    expect(isPathDeniedByReadJail(WORKTREE, WORKTREE, DENIED)).toBe(false);
  });

  test('file inside worktree is allowed', () => {
    expect(isPathDeniedByReadJail(`${WORKTREE}/src/index.ts`, WORKTREE, DENIED)).toBe(false);
  });

  test('deeply nested file inside worktree is allowed', () => {
    expect(isPathDeniedByReadJail(`${WORKTREE}/packages/core/db/schema.ts`, WORKTREE, DENIED)).toBe(false);
  });
});

describe('isPathDeniedByReadJail — sibling worktrees', () => {
  test('sibling worktree root is denied', () => {
    expect(isPathDeniedByReadJail(SIBLING_WORKTREE, WORKTREE, DENIED)).toBe(true);
  });

  test('file inside a sibling worktree is denied', () => {
    expect(isPathDeniedByReadJail(`${SIBLING_WORKTREE}/src/secret.ts`, WORKTREE, DENIED)).toBe(true);
  });

  test('.buildd-worktrees directory itself is denied', () => {
    expect(isPathDeniedByReadJail(`${REPO_PATH}/.buildd-worktrees`, WORKTREE, DENIED)).toBe(true);
  });
});

describe('isPathDeniedByReadJail — ~/.buildd', () => {
  test('~/.buildd/config.json is denied (runner API key)', () => {
    expect(isPathDeniedByReadJail(`${HOME}/.buildd/config.json`, WORKTREE, DENIED)).toBe(true);
  });

  test('~/.buildd/workers/<id>.json is denied (worker state)', () => {
    expect(isPathDeniedByReadJail(`${HOME}/.buildd/workers/abc123.json`, WORKTREE, DENIED)).toBe(true);
  });

  test('~/.buildd itself is denied', () => {
    expect(isPathDeniedByReadJail(`${HOME}/.buildd`, WORKTREE, DENIED)).toBe(true);
  });

  test('tilde expansion: ~/.buildd/config.json is denied', () => {
    expect(isPathDeniedByReadJail('~/.buildd/config.json', WORKTREE, DENIED)).toBe(true);
  });
});

describe('isPathDeniedByReadJail — Codex credential homes', () => {
  const OTHER_WORKER_ID = 'bcd456ef-0000-1111-2222-333344445555';

  test('$TMPDIR/buildd-codex-homes/<id>/auth.json is denied', () => {
    const authPath = join(TMP, 'buildd-codex-homes', OTHER_WORKER_ID, 'auth.json');
    expect(isPathDeniedByReadJail(authPath, WORKTREE, DENIED)).toBe(true);
  });

  test('$TMPDIR/buildd-codex-homes directory itself is denied', () => {
    expect(isPathDeniedByReadJail(join(TMP, 'buildd-codex-homes'), WORKTREE, DENIED)).toBe(true);
  });
});

describe('isPathDeniedByReadJail — Claude config dirs in $TMPDIR', () => {
  test('$TMPDIR/claude-cfg-XXXXXX/ is denied', () => {
    const claudeDir = join(TMP, 'claude-cfg-abcdef');
    expect(isPathDeniedByReadJail(claudeDir, WORKTREE, DENIED)).toBe(true);
  });

  test('file inside $TMPDIR/claude-cfg-XXXXXX/ is denied', () => {
    const credFile = join(TMP, 'claude-cfg-abcdef', 'settings.json');
    expect(isPathDeniedByReadJail(credFile, WORKTREE, DENIED)).toBe(true);
  });

  test('other $TMPDIR entries are not affected (not a claude-cfg dir)', () => {
    // e.g., a normal temp directory used by the agent's own tooling
    const normalTmpDir = join(TMP, 'my-build-cache');
    expect(isPathDeniedByReadJail(normalTmpDir, WORKTREE, DENIED)).toBe(false);
  });
});

describe('isPathDeniedByReadJail — system paths (allowed)', () => {
  test('/usr/bin/node is allowed (toolchain)', () => {
    expect(isPathDeniedByReadJail('/usr/bin/node', WORKTREE, DENIED)).toBe(false);
  });

  test('/etc/hosts is allowed', () => {
    expect(isPathDeniedByReadJail('/etc/hosts', WORKTREE, DENIED)).toBe(false);
  });

  test('/tmp/some-tool-output.txt is allowed (not a sensitive prefix)', () => {
    expect(isPathDeniedByReadJail('/tmp/some-tool-output.txt', WORKTREE, DENIED)).toBe(false);
  });

  test('${HOME}/.npmrc is allowed (not in .buildd)', () => {
    expect(isPathDeniedByReadJail(`${HOME}/.npmrc`, WORKTREE, DENIED)).toBe(false);
  });
});

describe('resolveToolPath', () => {
  test('absolute path is returned unchanged', () => {
    expect(resolveToolPath('/etc/hosts', WORKTREE)).toBe('/etc/hosts');
  });

  test('tilde path is returned unchanged (handled by isPathDeniedByReadJail)', () => {
    expect(resolveToolPath('~/.buildd/config.json', WORKTREE)).toBe('~/.buildd/config.json');
  });

  test('relative path is resolved against worktree', () => {
    expect(resolveToolPath('src/index.ts', WORKTREE)).toBe(join(WORKTREE, 'src/index.ts'));
  });

  test('path traversal resolved against worktree', () => {
    // A relative path that escapes the worktree — resolveToolPath doesn't block
    // it; isPathDeniedByReadJail does the blocking after normalization.
    const resolved = resolveToolPath('../../.buildd/config.json', WORKTREE);
    // Should resolve to something outside the worktree
    expect(resolved).not.toContain(WORKTREE);
  });
});

describe('CLAUDE_CFG_TMP_PREFIX constant', () => {
  test('matches the mkdtempSync prefix used by claude-auth.ts', () => {
    expect(CLAUDE_CFG_TMP_PREFIX).toBe('claude-cfg-');
  });
});
