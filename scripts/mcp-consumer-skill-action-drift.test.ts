import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
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
 *
 * The same gate covers the MCP guidance topics in packages/core/mcp-guidance/
 * (one Markdown file per topic, served by the MCP server and routed to from
 * the consumer skill). For `manage_specs` it goes one level deeper: a call
 * shape written as `buildd action=manage_specs params={ action: "<op>", ... }`
 * must name a sub-action the handler in packages/core/mcp-specs.ts has a
 * `case` for, and only params that handler (or mcp-tools.ts's workspace
 * resolution) reads. Rename `case 'read_ref':` there and the living-specs
 * topic goes red.
 */

const repoRoot = join(__dirname, '..');

const SKILLS = [
  { name: 'buildd-mcp-consumer', minActions: 5 },
  // `readiness`, `scaffold` and `author_spec` are the three new sub-actions
  // this skill drives; it must name every one of them.
  { name: 'workspace-onboarding', minActions: 5, mustName: ['readiness', 'scaffold', 'author_spec'] },
] as const;

const mcpToolsSource = readFileSync(join(repoRoot, 'packages/core/mcp-tools.ts'), 'utf8');
const mcpSpecsSource = readFileSync(join(repoRoot, 'packages/core/mcp-specs.ts'), 'utf8');

const GUIDANCE_DIR = 'packages/core/mcp-guidance';
const GUIDANCE_FILES = readdirSync(join(repoRoot, GUIDANCE_DIR)).filter(f => f.endsWith('.md')).sort();

/**
 * Guidance topics this task ships. Each must exist (an empty directory would
 * make every check below pass vacuously). `living-specs` must name every
 * manage_specs sub-action: it is the one place an agent learns the full set.
 */
const GUIDANCE_TOPICS: ReadonlyArray<{ topic: string; minActions: number; mustNameSpecOps?: true }> = [
  { topic: 'living-specs', minActions: 3, mustNameSpecOps: true },
  { topic: 'task-lifecycle', minActions: 5 },
  { topic: 'pr-landing', minActions: 5 },
  { topic: 'diagnosis', minActions: 5 },
];

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

/** The sub-actions handleSpecsAction actually dispatches: its `case '<op>':` labels. */
function specHandlerCases(src: string): Set<string> {
  const fn = src.slice(src.indexOf('export async function handleSpecsAction'));
  return new Set([...fn.matchAll(/case '([a-z_]+)':/g)].map(m => m[1]));
}

/**
 * Every param name the manage_specs path reads: `params.<name>`, the
 * `for (const k of [...] as const)` pass-through lists in mcp-specs.ts, and
 * `workspaceId`, which mcp-tools.ts resolves before delegating.
 */
function specHandlerParams(specsSrc: string, toolsSrc: string): Set<string> {
  const found = new Set<string>(['action']);
  for (const m of specsSrc.matchAll(/\bparams\.([a-zA-Z]+)/g)) found.add(m[1]);
  for (const list of specsSrc.matchAll(/for \(const k of \[([^\]]*)\] as const\)/g)) {
    for (const lit of list[1].matchAll(/'([a-zA-Z]+)'/g)) found.add(lit[1]);
  }
  const caseAt = toolsSrc.indexOf("case 'manage_specs':");
  const caseBody = toolsSrc.slice(caseAt, toolsSrc.indexOf('handleSpecsAction(', caseAt));
  for (const m of caseBody.matchAll(/\bparams\.([a-zA-Z]+)/g)) found.add(m[1]);
  return found;
}

/** Top-level keys of a `{ ... }` object literal written in prose (nested braces and brackets skipped). */
function topLevelKeys(obj: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let token = '';
  let expectKey = true;
  for (const ch of obj.slice(1)) {
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { if (depth === 0) break; depth--; }
    if (depth > 0) continue;
    if (/[A-Za-z0-9_]/.test(ch)) { if (expectKey) token += ch; continue; }
    if (token && expectKey && /[?:,\s}|]/.test(ch)) { keys.push(token); expectKey = false; }
    token = '';
    if (ch === ',') expectKey = true;
  }
  if (token && expectKey) keys.push(token);
  return keys;
}

/** The `{ ... }` starting at `from`, braces balanced. */
function balancedObject(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}

/**
 * Every `buildd action=manage_specs params={ action: "<op>", ... }` call shape
 * in a backticked span, as { op, keys }.
 */
function specCallShapes(body: string): Array<{ op: string; keys: string[] }> {
  const shapes: Array<{ op: string; keys: string[] }> = [];
  for (const spanMatch of body.matchAll(/`([^`]*)`/g)) {
    const span = spanMatch[1];
    const at = span.search(/\baction\s*=\s*manage_specs\b/);
    if (at < 0) continue;
    const brace = span.indexOf('{', at);
    if (brace < 0) continue;
    const obj = balancedObject(span, brace);
    const op = /\baction\s*:\s*"([a-z_]+)"/.exec(obj)?.[1] ?? '';
    shapes.push({ op, keys: topLevelKeys(obj) });
  }
  return shapes;
}

function specShapeProblems(body: string, cases: ReadonlySet<string>, params: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const { op, keys } of specCallShapes(body)) {
    if (!cases.has(op)) problems.push(`sub-action "${op}" has no case in handleSpecsAction`);
    for (const k of keys) if (!params.has(k)) problems.push(`${op}: param "${k}" is not read by the manage_specs handler`);
  }
  return problems;
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
  'head_claimed',
  // Error codes a reply carries, not actions.
  'spec_duplicate',
  'version_conflict',
  // A worker error prefix get_failure_analytics rolls up, not an action.
  'needs_input',
  // Claude Code's Bash tool parameter, how the skill says to run waitCommand.
  'run_in_background',
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
    // manage_specs sub-actions: the handler's own case labels, so a sub-action
    // named in prose must really dispatch.
    ...specHandlerCases(mcpSpecsSource),
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

describe('MCP guidance topics (packages/core/mcp-guidance/*.md)', () => {
  const cases = specHandlerCases(mcpSpecsSource);
  const params = specHandlerParams(mcpSpecsSource, mcpToolsSource);

  it('ships each topic this gate expects', () => {
    for (const { topic } of GUIDANCE_TOPICS) expect(GUIDANCE_FILES, topic).toContain(`${topic}.md`);
  });

  for (const file of GUIDANCE_FILES) {
    const body = readFileSync(join(repoRoot, GUIDANCE_DIR, file), 'utf8');
    const expected = GUIDANCE_TOPICS.find(t => `${t.topic}.md` === file);

    describe(file, () => {
      it('has skill-style frontmatter: name is the topic id, plus a one-line description', () => {
        const fm = /^---\n([\s\S]*?)\n---\n/.exec(body);
        expect(fm).not.toBeNull();
        expect(fm![1]).toMatch(new RegExp(`^name: ${file.replace(/\.md$/, '')}$`, 'm'));
        expect(fm![1]).toMatch(/^description: ".+"$/m);
      });

      if (expected) {
        it('found action-like identifiers to check', () => {
          expect(claimedActions(body, NOT_AN_ACTION).length).toBeGreaterThan(expected.minActions);
        });
      }

      it('every backticked action it names still exists', async () => {
        const { known } = await knownActions();
        expect(findDrifted(body, known, NOT_AN_ACTION)).toEqual([]);
      });

      it('every manage_specs call shape names a handled sub-action and only params the handler reads', () => {
        expect(specShapeProblems(body, cases, params)).toEqual([]);
      });

      if (expected?.mustNameSpecOps) {
        it('names every manage_specs sub-action as a call shape', () => {
          const named = new Set(specCallShapes(body).map(s => s.op));
          expect([...cases].filter(op => !named.has(op))).toEqual([]);
        });
      }
    });
  }
});

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

  it('reads the manage_specs handler: every SPEC_OPS entry has a case, and the param set is non-trivial', async () => {
    const { SPEC_OPS } = await import('../packages/core/mcp-specs');
    expect([...specHandlerCases(mcpSpecsSource)].sort()).toEqual([...SPEC_OPS].sort());
    const params = specHandlerParams(mcpSpecsSource, mcpToolsSource);
    for (const k of ['specId', 'expectedVersion', 'supersedes', 'distinctBecause', 'workspaceId', 'criterionId']) {
      expect(params.has(k), k).toBe(true);
    }
  });

  it('fails a manage_specs call shape with a wrong sub-action or an invented param', () => {
    const cases = specHandlerCases(mcpSpecsSource);
    const params = specHandlerParams(mcpSpecsSource, mcpToolsSource);
    const body = 'Then `buildd action=manage_specs params={ action: "approve_now", specId }` and '
      + '`buildd action=manage_specs params={ action: "revise", specId, expectedVersion, body, design: { kind, ref }, force: true }`.';
    expect(specShapeProblems(body, cases, params)).toEqual([
      'sub-action "approve_now" has no case in handleSpecsAction',
      'revise: param "force" is not read by the manage_specs handler',
    ]);
  });

  it('the non-action exclusion list names things that are genuinely not actions', async () => {
    const { known } = await knownActions();
    const wronglyExcluded = [...NOT_AN_ACTION].filter(id => known.has(id));
    expect(wronglyExcluded).toEqual([]);
  });
});
