/**
 * The rubric the goal-criteria verdict grades against
 * (docs/specs/mission-goal-criteria-quality.md §4), read from team memory and
 * bounded before it reaches the prompt.
 *
 * Three kinds of `memories` row, all tagged `goal-criteria-rubric`:
 * - the team's baseline (`decision`, `project` null) — replaces the code
 *   default for that team;
 * - workspace rubric notes (`decision`, the workspace's scope key);
 * - accepted patterns (`pattern`, also tagged `goal-criteria-accepted` and
 *   `fp:<criterionFingerprint>`), written when a criterion the judge warned on
 *   was kept and its mission completed cleanly. A criterion matching one is
 *   suppressed by fingerprint: never sent, never warned.
 *
 * The code default (`GOAL_QUALITY_BASELINE_RUBRIC`) ships here so a fresh team
 * with an empty memory grades the same as everyone else. Any read failure, a
 * timeout, or no rows means the code default and no accepted patterns.
 */
import { resolvePrompt, resolvePromptEntry, resolvedPromptVersion } from '@buildd/core/prompts';
import { createHash } from 'node:crypto';
import type { GoalCriterion } from '@buildd/shared';
import type { MemoryRecord, MemorySearchResult } from '@buildd/core/memory-store';

export const GOAL_CRITERIA_RUBRIC_TAG = 'goal-criteria-rubric';
export const GOAL_CRITERIA_ACCEPTED_TAG = 'goal-criteria-accepted';
/** Tag prefix carrying an accepted pattern's `criterionFingerprint`. */
export const ACCEPTED_FINGERPRINT_TAG_PREFIX = 'fp:';

/** Workspace notes and accepted patterns are each cut to this. */
export const RUBRIC_ENTRY_MAX_CHARS = 500;
/** A team baseline replaces the code default, which is longer than one entry. */
export const RUBRIC_BASELINE_MAX_CHARS = 1_500;
export const RUBRIC_MAX_CHARS = 4_000;
export const RUBRIC_MAX_WORKSPACE_NOTES = 5;
export const RUBRIC_MAX_ACCEPTED = 20;
export const RUBRIC_READ_TIMEOUT_MS = 1_000;
/** The version of the code default; anything read from memory hashes its own. */
export const CODE_RUBRIC_VERSION = 'base';

/**
 * The code-owned baseline rubric. Changing it changes what the judge is, so it
 * goes with a `GOAL_QUALITY_PROMPT_VERSION` bump.
 */
export const GOAL_QUALITY_BASELINE_RUBRIC = [
  'A mission goal is an Outcome (what a user, or the workspace owner for internal work, can do or see when the mission is done that they could not before), its Proof (a check that holds only when that outcome holds) and Bookkeeping.',
  'Bookkeeping is all PRs merged and no open tasks, or anything equally true of every finished mission (tests pass, CI green, branch deleted). It proves the work was closed out, not that anything changed.',
  'A command criterion is judged by the outcome its label says the command asserts: "a visitor can sign up from the landing page" names something a user would notice; "tests pass" or "build succeeds" does not.',
  'An artifact_exists criterion is judged by whether the deliverable it names is something a person would read or use.',
  'A description criterion is prose that a model or a person reads to grade.',
].join(' ');

export interface GoalQualityRubric {
  /** What goes into each question's `rule`. */
  text: string;
  /** `base` for the code default; otherwise a digest of everything that shaped the text. */
  version: string;
  /** Fingerprints of accepted patterns: criteria matching these are not graded. */
  acceptedFingerprints: string[];
}

/** The prompts-table id whose active row may replace the baseline rubric (`@buildd/core/prompts`). */
export const GOAL_QUALITY_RUBRIC_PROMPT_ID = 'buildd.goal_quality.rubric';

/**
 * The code default as this deployment resolves it: an active prompts row's
 * text (version `base+p<row version>`), else the public baseline (`base`).
 * Read through getters, so a row change is seen without a restart.
 */
export const CODE_RUBRIC: GoalQualityRubric = {
  get text() { return resolvePrompt(GOAL_QUALITY_RUBRIC_PROMPT_ID, GOAL_QUALITY_BASELINE_RUBRIC); },
  get version() {
    return resolvedPromptVersion(CODE_RUBRIC_VERSION, resolvePromptEntry(GOAL_QUALITY_RUBRIC_PROMPT_ID, GOAL_QUALITY_BASELINE_RUBRIC));
  },
  acceptedFingerprints: [],
};

/** What the composer needs from a memory row. */
export interface RubricEntry {
  content: string;
  tags: readonly string[];
  /** ISO; newest first is the order the caller passes. */
  updatedAt: string;
}

function cut(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function fingerprintOf(entry: RubricEntry): string | null {
  const tag = entry.tags.find(t => t.startsWith(ACCEPTED_FINGERPRINT_TAG_PREFIX));
  return tag ? tag.slice(ACCEPTED_FINGERPRINT_TAG_PREFIX.length) : null;
}

/**
 * Bound and join the rubric. Pure. The baseline is always whole (to its own
 * cap); workspace notes then accepted patterns follow, newest first, and the
 * oldest accepted patterns go first when the total is over, then the oldest
 * notes. A dropped accepted pattern still suppresses: suppression is by
 * fingerprint, the text is only context.
 */
export function composeGoalQualityRubric(input: {
  baseline?: string | null;
  notes?: readonly RubricEntry[];
  accepted?: readonly RubricEntry[];
}): GoalQualityRubric {
  const baselineText = input.baseline?.trim() ? cut(input.baseline, RUBRIC_BASELINE_MAX_CHARS) : null;
  const notes = (input.notes ?? []).slice(0, RUBRIC_MAX_WORKSPACE_NOTES)
    .map(n => `Workspace note: ${cut(n.content, RUBRIC_ENTRY_MAX_CHARS)}`);
  const acceptedRows = (input.accepted ?? []).slice(0, RUBRIC_MAX_ACCEPTED);
  const accepted = acceptedRows.map(a => `Accepted in this workspace: ${cut(a.content, RUBRIC_ENTRY_MAX_CHARS)}`);
  const acceptedFingerprints = [...new Set(acceptedRows.map(fingerprintOf).filter((f): f is string => !!f))];

  const base = baselineText ?? CODE_RUBRIC.text;
  const join = () => [base, ...notes, ...accepted].join(' ');
  while (join().length > RUBRIC_MAX_CHARS && accepted.length > 0) accepted.pop();
  while (join().length > RUBRIC_MAX_CHARS && notes.length > 0) notes.pop();
  const text = join().slice(0, RUBRIC_MAX_CHARS);

  if (!baselineText && notes.length === 0 && accepted.length === 0 && acceptedFingerprints.length === 0) return CODE_RUBRIC;
  const digest = createHash('sha256').update(text).update('\0').update(acceptedFingerprints.slice().sort().join(',')).digest('hex').slice(0, 8);
  return { text, version: `m${digest}`, acceptedFingerprints };
}

// ── Accepted patterns ────────────────────────────────────────────────────────

/**
 * The criterion's shape: its type and how it is built, never its text. Two
 * criteria with the same shape may say entirely different things; this is
 * what a person reading the memory learns, while suppression itself matches the
 * exact fingerprint.
 */
export function criterionShape(c: GoalCriterion): string {
  const parts: string[] = [c.type];
  if (c.label) parts.push('labelled');
  if (c.type === 'artifact_exists' && c.artifactType) parts.push(`artifactType=${c.artifactType}`);
  if (c.type === 'all_prs_merged' && c.requireBranchDeleted) parts.push('requireBranchDeleted');
  return parts.join(', ');
}

/** The memory written for an accepted pattern. No mission text, no ids. */
export function acceptedPatternMemory(c: GoalCriterion, fingerprint: string, project: string) {
  return {
    type: 'pattern' as const,
    title: `Goal criterion kept as written: ${c.type}`,
    content: `A goal criterion of shape [${criterionShape(c)}] was graded weak, kept as written, and its mission then completed with every criterion passing and no escalation. Do not warn on this criterion (fingerprint ${fingerprint}).`,
    project,
    tags: [GOAL_CRITERIA_RUBRIC_TAG, GOAL_CRITERIA_ACCEPTED_TAG, `${ACCEPTED_FINGERPRINT_TAG_PREFIX}${fingerprint}`],
  };
}

// ── Reading it ───────────────────────────────────────────────────────────────

/** The slice of `MemoryStore` this module uses; injectable for tests. */
export interface RubricMemoryReader {
  search(params: {
    type?: string;
    project?: string;
    tag?: string;
    teamWide?: boolean;
    states?: readonly ('active')[];
    limit?: number;
  }): Promise<{ results: MemorySearchResult[] }>;
  batch(ids: string[]): Promise<{ memories: MemoryRecord[] }>;
}

export interface LoadRubricDeps {
  store?: RubricMemoryReader;
  /** The workspace's memory scope key; null ⇒ team baseline only. */
  resolveProject?: (workspaceId: string) => Promise<string | null>;
  timeoutMs?: number;
}

async function readRubric(
  scope: { teamId: string; workspaceId: string | null },
  deps: LoadRubricDeps,
): Promise<GoalQualityRubric> {
  const store = deps.store ?? new (await import('@buildd/core/memory-store')).MemoryStore(scope.teamId);
  const resolveProject = deps.resolveProject ?? (await import('@buildd/core/memory-scope')).resolveMemoryProjectKey;
  const project = scope.workspaceId ? await resolveProject(scope.workspaceId) : null;

  const active = ['active'] as const;
  const [baseline, notes, accepted] = await Promise.all([
    store.search({ type: 'decision', tag: GOAL_CRITERIA_RUBRIC_TAG, teamWide: true, states: active, limit: 1 }),
    project
      ? store.search({ type: 'decision', tag: GOAL_CRITERIA_RUBRIC_TAG, project, states: active, limit: RUBRIC_MAX_WORKSPACE_NOTES })
      : { results: [] },
    project
      ? store.search({ type: 'pattern', tag: GOAL_CRITERIA_ACCEPTED_TAG, project, states: active, limit: RUBRIC_MAX_ACCEPTED })
      : { results: [] },
  ]);
  const ids = [...baseline.results, ...notes.results, ...accepted.results].map(r => r.id);
  if (ids.length === 0) return CODE_RUBRIC;
  const { memories } = await store.batch(ids);
  const byId = new Map(memories.map(m => [m.id, m]));
  const entries = (rows: MemorySearchResult[]): RubricEntry[] => rows
    .map(r => byId.get(r.id))
    .filter((m): m is MemoryRecord => !!m)
    .map(m => ({ content: m.content, tags: m.tags, updatedAt: m.updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return composeGoalQualityRubric({
    baseline: entries(baseline.results)[0]?.content ?? null,
    notes: entries(notes.results),
    accepted: entries(accepted.results),
  });
}

/**
 * The rubric for one graded write. Never throws and never waits longer than
 * `RUBRIC_READ_TIMEOUT_MS`: anything but a clean read is the code default.
 */
export async function loadGoalQualityRubric(
  scope: { teamId: string; workspaceId: string | null },
  deps: LoadRubricDeps = {},
): Promise<GoalQualityRubric> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<GoalQualityRubric>(resolve => {
      timer = setTimeout(() => resolve(CODE_RUBRIC), deps.timeoutMs ?? RUBRIC_READ_TIMEOUT_MS);
    });
    return await Promise.race([readRubric(scope, deps).catch(() => CODE_RUBRIC), timeout]);
  } catch {
    return CODE_RUBRIC;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
