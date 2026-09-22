import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';

/**
 * Two workflow-level signals that were structurally unable to report a
 * problem, in the same class as the five repaired in
 * `packages/core/signal-registry.ts`:
 *
 * - `ci-fix.yml`'s auto-repair responder failed 45 of 56 fires over a 30-day
 *   window, every failure at the `claude-code-action@v1` step. ~47% were the
 *   action refusing to run at all — its default `allowed_bots: ""` rejects
 *   any Bot actor, and this workflow's only possible triggering pushes to
 *   `dev` are either human or one of two known bots (buildd-ai, buildd-release).
 *   Another ~47% hit the 30-turn cap; several of the runs that DID succeed
 *   finished at 26-28/30 turns, so the cap was already close to binding on a
 *   working fix.
 * - `visual-qa.yml` skipped 287 of 287 pull_request-triggered runs (500 of
 *   500 in the full recorded history). Its job `if:` required a `visual-qa`
 *   PR label that nothing in this codebase ever applies, and the gate's own
 *   documented removal condition ("once a dispatch run comes back green")
 *   was never even attempted — this repo has zero workflow_dispatch runs of
 *   this workflow anywhere in its history before this fix.
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
    // Measured: successful runs in the audited window finished as high as
    // 28/30 turns. 30 was already close to binding on a WORKING fix, so it
    // undersized a harder one rather than genuinely signaling "unfixable".
    expect(Number(match![1])).toBeGreaterThanOrEqual(50);
  });
});

describe('visual-qa.yml: the job can actually run on a real dev→main release PR', () => {
  const parsed = parsedWorkflow('.github/workflows/visual-qa.yml');
  const job = parsed?.jobs?.['visual-qa'];

  it('finds the job at all', () => {
    expect(job).toBeDefined();
  });

  // @signal-fire: visual-qa-trigger-reachable
  it('does not gate on a label nothing in this repo ever applies', () => {
    const cond = String(job?.if ?? '');
    // The exact shape of the dead gate: an unsatisfiable AND'd label check.
    expect(cond).not.toMatch(/contains\([^)]*labels[^)]*\)/);
    // Something must still scope this to release PRs (dev-sourced) or a
    // manual run — dropping the label gate must not mean "always run".
    expect(cond.includes('head_ref') || cond.includes('workflow_dispatch')).toBe(true);
  });
});
