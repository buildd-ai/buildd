/**
 * The Claude Code CLI this runner bundles must serve every model the claim
 * route vouches for.
 *
 * A row in MODEL_MIN_CLI_VERSION makes the claim route dispatch that model;
 * the runner reports the bundled CLI's version (resolveClaudeCliVersion) and
 * a runner below the floor gets the task deferred instead. So a floor above
 * the bundled CLI defers every such task on every runner we ship, and a new
 * model with no row is refused as `newer_than_floor_table` and served by the
 * tier fallback, claim after claim (Sonnet 5.5 in early October, Haiku 5.5 at
 * the end of it). Adding the row and bumping the SDK go together.
 */
import { describe, test, expect } from 'bun:test';
import { MODEL_MIN_CLI_VERSION, compareCliVersions } from '@buildd/core/model-capability-requirements';
import { resolveClaudeCliVersion } from '../../src/sdk-binary-path';

describe('bundled Claude Code CLI', () => {
  const bundled = resolveClaudeCliVersion();

  test('reports a version', () => {
    expect(bundled).toMatch(/^\d+\.\d+\.\d+/);
  });

  for (const [model, floor] of Object.entries(MODEL_MIN_CLI_VERSION)) {
    test(`meets the recorded floor for ${model} (${floor})`, () => {
      expect(compareCliVersions(bundled!, floor)).toBeGreaterThanOrEqual(0);
    });
  }
});
