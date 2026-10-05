import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Drift gate for the repo-committed buildd MCP skills
 * (docs/design/buildd-mcp-consumer-skill.md, decision 6 / Q3, and
 * docs/design/workspace-onboarding.md section 5): a skill names `buildd`
 * actions by their exact identifier (claim_task, create_artifact, readiness,
 * ...). If the server ever renames or removes one of those without a matching
 * skill edit, the skill quietly tells agents to call something that no longer
 * exists — worse than shipping no skill at all.
 *
 * Same technique docs/specs/SPEC-FORMAT.md rule 7 uses for specs, and the
 * same shape as scripts/skills-listed.test.ts: a backticked identifier is a
 * claim, and this test resolves the claim against the source of truth
 * (packages/core/mcp-tools.ts's action lists) instead of trusting prose.
 *
 * To prove this gate can actually fail (not just pass on an empty set): edit
 * `packages/core/mcp-tools.ts` to rename an action a skill references (e.g.
 * `create_pr` -> `open_pr`, or the `author_spec` workspace sub-action) and
 * re-run this file — 'every backticked action the skill names still exists'
 * goes red. Revert and it's green again.
 */

const repoRoot = join(__dirname, '..');

const SKILLS = [
  { name: 'buildd-mcp-consumer', minActions: 5 },
  // `readiness`, `scaffold` and `author_spec` are the three new sub-actions
  // this skill drives; it must name every one of them.
  { name: 'workspace-onboarding', minActions: 5, mustName: ['readiness', 'scaffold', 'author_spec'] },
] as const;

const mcpToolsSource = readFileSync(join(repoRoot, 'packages/core/mcp-tools.ts'), 'utf8');

/**
 * Backticked, underscore-bearing identifiers in the skill body. Restricting
 * to underscore-bearing tokens (rather than every backticked word) excludes
 * bare tool names (`buildd`, `recall`, `learn`), field names without an
 * action shape (`baseBranch`), and skill-vocabulary terms that use a hyphen,
 * not an underscore (`mission-branch`, `owner-decision`) — none of those are
 * `buildd` actions.
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
 * Identifiers written in the `action=<id>` / `action: "<id>"` form inside a
 * backticked span, with or without an underscore. This is what catches a bare
 * single-word action such as `readiness`, which the underscore filter above
 * cannot see.
 */
function backtickedActionArguments(body: string): string[] {
  const found = new Set<string>();
  for (const spanMatch of body.matchAll(/`([^`]*)`/g)) {
    for (const idMatch of spanMatch[1].matchAll(/\baction\s*[=:]\s*"?([a-z][a-z0-9_]*)"?/g)) {
      found.add(idMatch[1]);
    }
  }
  return [...found].sort();
}

/**
 * Actions that are not top-level `allActions` entries but are real: the
 * `action` union a group action (`manage_workspaces`, `manage_missions`, ...)
 * documents in its own description, e.g. readiness / scaffold / author_spec.
 * Parsed from the same source file so there is no second list to drift.
 */
function subActionsFromSource(src: string): Set<string> {
  const found = new Set<string>();
  for (const union of src.matchAll(/\baction\??: ((?:"[a-z_]+"\s*\|?\s*)+)/g)) {
    for (const lit of union[1].matchAll(/"([a-z_]+)"/g)) found.add(lit[1]);
  }
  return found;
}

/** Every identifier the body claims is an action, minus the known non-actions. */
function claimedActions(body: string, notAnAction: ReadonlySet<string>): string[] {
  return [...new Set([...backtickedActionLikeIdentifiers(body), ...backtickedActionArguments(body)])]
    .filter(id => !notAnAction.has(id))
    .sort();
}

function findDrifted(body: string, known: ReadonlySet<string>, notAnAction: ReadonlySet<string>): string[] {
  return claimedActions(body, notAnAction).filter(id => !known.has(id));
}

/**
 * Backticked identifiers that look action-shaped but name something else —
 * an artifact `type` value, a task field value or a spec frontmatter key
 * (`verified_by`), not a `buildd` action.
 * Anything landing here must NOT also be a real action (guarded below), so the
 * exclusion can't quietly cover for an actual rename.
 */
const NOT_AN_ACTION = new Set([
  'impl_plan',
  'pr_required',
  'artifact_required',
  'coder_report_task',
  'verified_by',
  'head_not_owned',
]);

async function knownActions(): Promise<{ topLevel: Set<string>; known: Set<string> }> {
  const { allActions } = await import('../packages/core/mcp-tools');
  // The group tool names (`buildd_work`, ...) are real identifiers too.
  const { MCP_TOOL_GROUPS, mcpGroupToolName } = await import('../packages/core/mcp-tool-groups');
  const topLevel = new Set<string>(allActions);
  const known = new Set<string>([
    ...allActions,
    ...MCP_TOOL_GROUPS.map(mcpGroupToolName),
    ...subActionsFromSource(mcpToolsSource),
  ]);
  return { topLevel, known };
}

for (const skill of SKILLS) {
  const skillBody = readFileSync(join(repoRoot, `.claude/skills/${skill.name}/SKILL.md`), 'utf8');

  describe(`${skill.name} skill vs. packages/core/mcp-tools.ts action vocabulary`, () => {
    it('found action-like identifiers to check (guards an empty set passing vacuously)', () => {
      expect(claimedActions(skillBody, NOT_AN_ACTION).length).toBeGreaterThan(skill.minActions);
    });

    it('every backticked action the skill names still exists in mcp-tools.ts', async () => {
      const { known } = await knownActions();
      expect(findDrifted(skillBody, known, NOT_AN_ACTION)).toEqual([]);
    });

    if ('mustName' in skill) {
      it('names each action it exists to drive', () => {
        const claimed = new Set(claimedActions(skillBody, NOT_AN_ACTION));
        for (const id of skill.mustName) expect(claimed.has(id), id).toBe(true);
      });
    }
  });
}

describe('action drift gate mechanics', () => {
  it('fails on a backticked action that does not exist, bare or underscored', async () => {
    const { known } = await knownActions();
    const body = 'Run `buildd action=frobnicate` then `buildd action=launch_rocket params={ id }`.';
    expect(findDrifted(body, known, NOT_AN_ACTION)).toEqual(['frobnicate', 'launch_rocket']);
  });

  it('resolves workspace sub-actions that are not top-level allActions entries', async () => {
    const { topLevel, known } = await knownActions();
    for (const id of ['readiness', 'scaffold', 'author_spec']) {
      expect(topLevel.has(id), `${id} is a sub-action, not a top-level action`).toBe(false);
      expect(known.has(id), id).toBe(true);
    }
  });

  it('each onboarding sub-action has a handler, not just a mention in a description', () => {
    for (const id of ['readiness', 'scaffold', 'author_spec']) {
      expect(mcpToolsSource).toContain(`case '${id}':`);
    }
  });

  it('the non-action exclusion list names things that are genuinely not actions', async () => {
    const { known } = await knownActions();
    const wronglyExcluded = [...NOT_AN_ACTION].filter(id => known.has(id));
    expect(wronglyExcluded).toEqual([]);
  });
});
