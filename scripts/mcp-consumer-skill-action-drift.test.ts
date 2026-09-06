import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Drift gate for `.claude/skills/buildd-mcp-consumer/SKILL.md`
 * (docs/design/buildd-mcp-consumer-skill.md, decision 6 / Q3): the skill
 * names `buildd` actions by their exact identifier (claim_task,
 * create_artifact, ...). If the server ever renames or removes one of those
 * without a matching skill edit, the skill quietly tells agents to call
 * something that no longer exists — worse than shipping no skill at all.
 *
 * Same technique docs/specs/SPEC-FORMAT.md rule 7 uses for specs, and the
 * same shape as scripts/skills-listed.test.ts: a backticked identifier is a
 * claim, and this test resolves the claim against the source of truth
 * (packages/core/mcp-tools.ts's action lists) instead of trusting prose.
 *
 * To prove this gate can actually fail (not just pass on an empty set): edit
 * `packages/core/mcp-tools.ts` to rename an action the skill references (e.g.
 * `create_pr` -> `open_pr`) and re-run this file — 'every backticked action
 * the skill names still exists' goes red. Revert and it's green again.
 */

const repoRoot = join(__dirname, '..');
const skillPath = join(repoRoot, '.claude/skills/buildd-mcp-consumer/SKILL.md');
const skillBody = readFileSync(skillPath, 'utf8');

/**
 * Backticked, underscore-bearing identifiers in the skill body. Restricting
 * to underscore-bearing tokens (rather than every backticked word) excludes
 * bare tool names (`buildd`, `recall`, `learn`), field names without an
 * action shape (`baseBranch`), and skill-vocabulary terms that use a hyphen,
 * not an underscore (`mission-branch`) — none of those are `buildd` actions.
 */
function backtickedActionLikeIdentifiers(body: string): string[] {
  const found = new Set<string>();
  for (const spanMatch of body.matchAll(/`([^`]*)`/g)) {
    for (const idMatch of spanMatch[1].matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
      found.add(idMatch[0]);
    }
  }
  return [...found].sort();
}

/**
 * Backticked identifiers that look action-shaped but name something else —
 * an artifact `type` value, not a `buildd` action. Anything landing here
 * must NOT also be a real action (guarded below), so the exclusion can't
 * quietly cover for an actual rename.
 */
const NOT_AN_ACTION = new Set(['impl_plan']);

describe('buildd-mcp-consumer skill vs. packages/core/mcp-tools.ts action vocabulary', () => {
  it('found action-like identifiers to check (guards an empty set passing vacuously)', () => {
    const found = backtickedActionLikeIdentifiers(skillBody).filter(id => !NOT_AN_ACTION.has(id));
    expect(found.length).toBeGreaterThan(5);
  });

  it('every backticked action the skill names still exists in mcp-tools.ts', async () => {
    const { allActions } = await import('../packages/core/mcp-tools');
    const allActionsSet = new Set<string>(allActions);

    const referenced = backtickedActionLikeIdentifiers(skillBody).filter(
      id => !NOT_AN_ACTION.has(id),
    );
    const drifted = referenced.filter(id => !allActionsSet.has(id));
    expect(drifted).toEqual([]);
  });

  it('the non-action exclusion list names things that are genuinely not actions', async () => {
    const { allActions } = await import('../packages/core/mcp-tools');
    const allActionsSet = new Set<string>(allActions);
    const wronglyExcluded = [...NOT_AN_ACTION].filter(id => allActionsSet.has(id));
    expect(wronglyExcluded).toEqual([]);
  });
});
