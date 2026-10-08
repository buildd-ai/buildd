/**
 * Test workspace utilities for runner unit tests.
 *
 * Each test file gets its own mkdtemp directory to prevent parallel test interference.
 * This is critical in CI shards where multiple files run concurrently and would
 * otherwise race on cleanup of a shared `/tmp/test-workspace` directory.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let testWorkspace: string | null = null;

/**
 * Initialize a unique temporary workspace for this test file.
 * Must be called once per test file (e.g., in beforeAll or at module scope).
 * Returns the path to the temporary directory.
 */
export function initTestWorkspace(): string {
  if (testWorkspace === null) {
    testWorkspace = mkdtempSync(join(tmpdir(), 'buildd-test-workspace-'));
  }
  return testWorkspace;
}

/**
 * Get the current test workspace path. Lazily initializes on first call.
 */
export function getTestWorkspace(): string {
  if (testWorkspace === null) {
    initTestWorkspace();
  }
  return testWorkspace!;
}

/**
 * Clean up the test workspace. Should be called in afterAll().
 * Safely handles non-existent directories.
 */
export function cleanupTestWorkspace(): void {
  if (testWorkspace !== null) {
    try {
      rmSync(testWorkspace, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already gone
    }
    testWorkspace = null;
  }
}

/**
 * Reset the test workspace (for testing purposes).
 * Use this in tests that verify workspace initialization.
 */
export function resetTestWorkspace(): void {
  testWorkspace = null;
}
