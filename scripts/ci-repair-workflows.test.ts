import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';

/**
 * `ci-fix.yml`'s auto-repair responder was structurally unable to do its job,
 * in the same class as the signals repaired in `packages/core/signal-registry.ts`.
 * Every failure landed at the `claude-code-action@v1` step, for two reasons:
 *
 * - The action refused to run at all — its default `allowed_bots: ""` rejects
 *   any Bot actor, and this workflow's only possible triggering pushes to
 *   `dev` are either human or one of two known bots (buildd-ai, buildd-release).
 * - The 30-turn cap. Runs that DID succeed were finishing just under it, so the
 *   cap was already close to binding on a working fix.
 *
 * These assert on the parsed YAML, not on grep, matching `workflow-safety.test.ts`.
 */

function parsedWorkflow(file: string): any {
  return Bun.YAML.parse(readFileSync(file, 'utf8'));
}

/** Every step across every job in a parsed workflow, flattened. */
function allSteps(parsed: any): any[] {
  return Object.values<any>(parsed?.jobs ?? {}).flatMap(job => job?.steps ?? []);
}

describe('ci-fix.yml: claude-code-action can actually run on this repo\'s only real trigger', () => {
  const parsed = parsedWorkflow('.github/workflows/ci-fix.yml');
  const claudeStep = allSteps(parsed).find(s => s?.uses?.startsWith('anthropics/claude-code-action'));

  it('finds the auto-fix step at all', () => {
    // A path/step-selector typo would make every assertion below vacuously true.
    expect(claudeStep).toBeDefined();
  });

  // @signal-fire: ci-fix-bot-actor-allowlist
  it('allows the two bots this workflow can ever be triggered by, and nothing wider', () => {
    const allowedBots = String(claudeStep?.with?.allowed_bots ?? '');
    const named = allowedBots.split(',').map(s => s.trim()).filter(Boolean);
    expect(named).toContain('buildd-ai');
    expect(named).toContain('buildd-release');
    // Never '*' on a public repo — see the allowed_bots input's own security
    // warning (docs/security.md): a wildcard lets any external bot invoke this
    // action with prompts it controls. Naming the two real bots is the fix,
    // not opening the gate.
    expect(allowedBots.trim()).not.toBe('*');
  });

  // @signal-fire: ci-fix-max-turns-headroom
  it('gives the fix agent headroom above what a working run has actually needed', () => {
    const args = String(claudeStep?.with?.claude_args ?? '');
    const match = /--max-turns\s+(\d+)/.exec(args);
    expect(match, 'claude_args has no --max-turns').not.toBeNull();
    // Successful runs were finishing just under the old 30-turn cap, so it was
    // already close to binding on a WORKING fix and undersized a harder one
    // rather than genuinely signaling "unfixable".
    expect(Number(match![1])).toBeGreaterThanOrEqual(50);
  });
});
