import { describe, it, expect } from 'bun:test';
import { resolveClaudeCliVersion } from '../../src/sdk-binary-path';

/**
 * `resolveClaudeCliVersion` reads the bundled CLI version out of the
 * installed @anthropic-ai/claude-agent-sdk's manifest.json — the value the
 * claim-time capability gate (model-capability-requirements.ts) compares
 * against a task's resolved model. This runs against the real installed
 * package rather than a mock: the thing worth catching is the SDK moving
 * manifest.json or dropping the `version` field, which a mock would hide.
 */
describe('resolveClaudeCliVersion', () => {
  it('reads a dotted CLI version from the installed SDK manifest', () => {
    const version = resolveClaudeCliVersion();
    expect(version).toBeDefined();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is cached — repeated calls return the same value', () => {
    expect(resolveClaudeCliVersion()).toBe(resolveClaudeCliVersion());
  });
});
