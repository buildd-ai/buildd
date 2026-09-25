/**
 * Predicting which files a task is about, from what similar finished tasks
 * actually touched.
 *
 * **This is for RETRIEVAL ONLY, and it is advisory. It is never written to
 * `tasks.path_manifest`.** That column feeds path-overlap serialisation and
 * inferred `dependsOn` in the claim route, and a wrong prediction there does
 * not degrade a prompt — it defers or serialises unrelated real work, and the
 * failure looks like ordinary contention. `./task-path-inference.ts` is kept
 * out of that column for exactly this reason and so is this. The prediction
 * lives in its own table (`task_area_prediction_events`), is read by retrieval
 * and by nothing else, and can be deleted without touching a task row.
 *
 * ── What it does ───────────────────────────────────────────────────────────
 *
 * The `### Relevant to This Task` block picks memories by declared paths, then
 * by paths regexed out of the task's own text, then by title tokens — and the
 * store behind it has no relevance ranking, so it falls back to
 * most-recently-updated. Over the memory-digest cohort roughly 6% of prompts
 * matched on a declared manifest, ~57% on regex-inferred paths and ~36% on
 * title tokens: most "relevant" memories are selected by a regex and sorted by
 * recency.
 *
 * So: at query time, find the completed tasks most similar to this one, take
 * the files those tasks actually touched, and use the union as the predicted
 * area. Nothing is precomputed, nothing is clustered, no third store is
 * introduced — the task corpus is already embedded and already current, and a
 * finished task's file list is known rather than guessed.
 *
 * ── Why a neighbour's *diff* rather than its manifest ──────────────────────
 *
 * Both are available and `pathSource` selects between them at runtime, because
 * which one predicts better is the kind of thing that should be measured
 * rather than asserted. The default is the diff: a manifest is what someone
 * predicted at creation time, often empty and sometimes wrong, whereas the
 * diff is what happened. Anything clustering on manifests clusters on noise.
 *
 * ── Every parameter is a parameter ─────────────────────────────────────────
 *
 * Top-k, the similarity floor, the union cap, the per-neighbour cap, the path
 * source and whether the feature runs at all are all fields on
 * `TaskAreaConfig`, resolved at runtime from `system_cache` over env over the
 * in-code fallback (see `./task-area-prediction-source.ts`). `TASK_AREA_FALLBACK`
 * below is the value used when an operator has configured nothing at all; it is
 * not a compiled-in setting, and changing any of these needs no deploy.
 *
 * This module is pure — no DB, no network, no imports that reach either — so
 * the arithmetic and the union rules are testable against literal rows. The
 * query half lives in `./task-area-prediction-source.ts`.
 */
import { assignExperimentArm, type ExperimentAssignment } from './experiment-randomizer';
import { stripTrailingSep } from './path-overlap';

// ── Experiment identity ───────────────────────────────────────────────────────

/**
 * Stable experiment id. Part of the randomiser's salt, so this experiment's
 * draw does not correlate with any other experiment keyed on task ids.
 */
export const TASK_AREA_EXPERIMENT_ID = 'task-area-prediction';

/**
 * Default policy version. Bump (via config — it is a `TaskAreaConfig` field,
 * not a constant a deploy has to carry) whenever the meaning of an arm changes:
 * a different path source, a different union rule, a different retrieval step
 * order. Assignments drawn under a different version are not comparable, and
 * the version is part of the salt so a bump re-randomises rather than letting
 * every task keep the arm it drew under the old definition.
 */
export const TASK_AREA_DEFAULT_POLICY_VERSION = 'task-area-v1';

/**
 * Control runs today's behaviour: declared manifest, then regex-inferred paths,
 * then the title. Treatment inserts the predicted neighbourhood ahead of the
 * regex step.
 *
 * Both arms COMPUTE the prediction and the regex baseline — only the treatment
 * arm lets the prediction reach retrieval. That is what makes the overlap
 * metric answerable for both predictors over the same tasks in the same run,
 * which is the whole point: "half or better" means nothing against a regex that
 * may already score comparably.
 */
export const TASK_AREA_CONTROL_ARM = 'regex_paths';
export const TASK_AREA_TREATMENT_ARM = 'neighbour_area';
export type TaskAreaArm = typeof TASK_AREA_CONTROL_ARM | typeof TASK_AREA_TREATMENT_ARM;

// ── Configuration ─────────────────────────────────────────────────────────────

/** Where a neighbour's paths come from. */
export type NeighbourPathSource = 'diff' | 'manifest';

export interface TaskAreaConfig {
  /** Master switch. Off means no prediction is computed, recorded, or used. */
  enabled: boolean;
  /** Share of tasks assigned the treatment arm. Out-of-range values run the control. */
  fraction: number;
  /** Salt + cohort key. See TASK_AREA_DEFAULT_POLICY_VERSION. */
  policyVersion: string;
  /** How many completed neighbour tasks to retrieve. */
  topK: number;
  /** Minimum similarity for a neighbour to contribute paths at all. */
  similarityFloor: number;
  /** Hard cap on the size of the unioned prediction. */
  maxPaths: number;
  /** Cap on paths taken from any one neighbour, so a 200-file refactor cannot be the whole prediction. */
  maxPathsPerNeighbour: number;
  /** Diff (what happened) or declared manifest (what someone predicted). */
  pathSource: NeighbourPathSource;
}

/**
 * The value in effect when nothing is configured anywhere.
 *
 * `enabled: true` with `fraction: 0` is the deliberate shape: the prediction and
 * the regex baseline are computed and recorded for every task from the first
 * deploy, so the overlap metric starts accruing immediately, while NO task's
 * retrieval changes until someone sets a fraction. Measurement first, behaviour
 * change on an operator's say-so.
 */
export const TASK_AREA_FALLBACK: TaskAreaConfig = {
  enabled: true,
  fraction: 0,
  policyVersion: TASK_AREA_DEFAULT_POLICY_VERSION,
  topK: 8,
  similarityFloor: 0.3,
  maxPaths: 12,
  maxPathsPerNeighbour: 8,
  pathSource: 'diff',
};

/** `system_cache` key holding the operator-set overrides. */
export const TASK_AREA_CONFIG_CACHE_KEY = 'task_area_prediction_config';

/** Env var names, one per field — the override that works before a DB row exists. */
export const TASK_AREA_ENV_KEYS: Record<keyof TaskAreaConfig, string> = {
  enabled: 'BUILDD_TASK_AREA_ENABLED',
  fraction: 'BUILDD_TASK_AREA_FRACTION',
  policyVersion: 'BUILDD_TASK_AREA_POLICY_VERSION',
  topK: 'BUILDD_TASK_AREA_TOP_K',
  similarityFloor: 'BUILDD_TASK_AREA_SIMILARITY_FLOOR',
  maxPaths: 'BUILDD_TASK_AREA_MAX_PATHS',
  maxPathsPerNeighbour: 'BUILDD_TASK_AREA_MAX_PATHS_PER_NEIGHBOUR',
  pathSource: 'BUILDD_TASK_AREA_PATH_SOURCE',
};

/** A field an override tried to set and the resolver refused. */
export interface RejectedOverride {
  field: keyof TaskAreaConfig;
  /** The offending value, stringified — so the log names what was actually set. */
  value: string;
  why: string;
}

export interface ResolvedTaskAreaConfig {
  config: TaskAreaConfig;
  /**
   * Overrides that were present and refused. Never silently dropped: a
   * fat-fingered knob that quietly reverts to the fallback is how an
   * experiment ends up reporting on a cohort nobody configured.
   */
  rejected: RejectedOverride[];
}

function boolFrom(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return undefined;
}

function numberFrom(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Merge override layers onto the fallback, rejecting anything out of range.
 *
 * Layers are applied in order, so the caller decides precedence (the source
 * module passes env first, then the `system_cache` row, so the DB row — the
 * one an operator can change without a deploy — wins).
 *
 * Out-of-range is REFUSED, not clamped, on the same reasoning as
 * `resolveEnrolmentFraction`: a `topK` of 0 or a `maxPaths` of -1 is a typo,
 * and silently coercing it to a working value hides the typo behind a cohort
 * that looks fine. `fraction` is deliberately NOT validated here — it is passed
 * through to `resolveEnrolmentFraction` at draw time, which owns that rule.
 */
export function resolveTaskAreaConfig(
  ...layers: Array<Record<string, unknown> | null | undefined>
): ResolvedTaskAreaConfig {
  const config: TaskAreaConfig = { ...TASK_AREA_FALLBACK };
  const rejected: RejectedOverride[] = [];
  const reject = (field: keyof TaskAreaConfig, value: unknown, why: string) =>
    rejected.push({ field, value: String(value), why });

  for (const layer of layers) {
    if (!layer) continue;

    for (const [field, raw] of Object.entries(layer) as Array<[keyof TaskAreaConfig, unknown]>) {
      if (raw === undefined || raw === null || raw === '') continue;

      switch (field) {
        case 'enabled': {
          const v = boolFrom(raw);
          if (v === undefined) reject(field, raw, 'not a boolean');
          else config.enabled = v;
          break;
        }
        case 'fraction': {
          // Range is resolveEnrolmentFraction's call, not ours — it runs on
          // this value at draw time and rejects out-of-range to 0 there.
          const v = numberFrom(raw);
          if (v === undefined) reject(field, raw, 'not a number');
          else config.fraction = v;
          break;
        }
        case 'policyVersion': {
          if (typeof raw !== 'string' || !raw.trim()) reject(field, raw, 'not a non-empty string');
          else config.policyVersion = raw.trim();
          break;
        }
        case 'pathSource': {
          if (raw !== 'diff' && raw !== 'manifest') reject(field, raw, "not 'diff' or 'manifest'");
          else config.pathSource = raw;
          break;
        }
        case 'similarityFloor': {
          const v = numberFrom(raw);
          if (v === undefined) reject(field, raw, 'not a number');
          else if (v < 0 || v > 1) reject(field, raw, 'outside [0, 1]');
          else config.similarityFloor = v;
          break;
        }
        case 'topK':
        case 'maxPaths':
        case 'maxPathsPerNeighbour': {
          const v = numberFrom(raw);
          if (v === undefined) reject(field, raw, 'not a number');
          else if (!Number.isInteger(v) || v < 1) reject(field, raw, 'not a positive integer');
          else config[field] = v;
          break;
        }
        default:
          // An unknown key is an operator typo on a field name. Ignored rather
          // than rejected: the union of every field name this module has ever
          // had is not knowable here, and a removed knob must not start failing.
          break;
      }
    }
  }

  return { config, rejected };
}

/**
 * Read the configured knobs out of an environment bag.
 *
 * Returns only the keys actually present, so an unset var is "no opinion"
 * rather than an override to `undefined` that would shadow the DB row.
 */
export function taskAreaConfigFromEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(TASK_AREA_ENV_KEYS)) {
    const raw = env[key];
    if (raw !== undefined && raw !== '') out[field] = raw;
  }
  return out;
}

// ── Arm assignment ────────────────────────────────────────────────────────────

/**
 * Draw this task's arm through the shared randomiser.
 *
 * Deliberately a thin wrapper and not a second draw: it supplies this
 * experiment's identity, version and arm pair, and nothing else. Propensity is
 * whatever the randomiser recorded at assignment time — never reconstructed
 * later from the configured fraction, which can be changed between the draw
 * and the analysis.
 */
export function assignTaskAreaArm(
  taskId: string | null | undefined,
  config: TaskAreaConfig,
): ExperimentAssignment<TaskAreaArm> {
  return assignExperimentArm<TaskAreaArm>({
    experimentId: TASK_AREA_EXPERIMENT_ID,
    policyVersion: config.policyVersion,
    controlArm: TASK_AREA_CONTROL_ARM,
    treatmentArm: TASK_AREA_TREATMENT_ARM,
    unitId: taskId,
    fraction: config.fraction,
  });
}

// ── Building the prediction ───────────────────────────────────────────────────

/** One completed task the store returned as similar, with the files it touched. */
export interface NeighbourTask {
  taskId: string;
  /** Similarity as the store scored it. */
  score: number;
  /** Repo-relative paths, already resolved from whichever source the config named. */
  paths: string[];
}

export interface TaskAreaPredictionResult {
  /** The predicted area: the capped, ordered union. */
  paths: string[];
  /** Neighbours that cleared the floor AND contributed at least one path. */
  contributors: Array<{ taskId: string; score: number; contributed: number }>;
  /** Neighbours returned by the store, before the floor and the path lookup. */
  considered: number;
  /** Best similarity among the considered neighbours, or null when there were none. */
  topScore: number | null;
  /** True when the union hit `maxPaths` and paths were dropped. */
  truncated: boolean;
}

/**
 * Union the neighbours' paths into the predicted area.
 *
 * Ordered by neighbour similarity, then by the order the paths came back
 * within a neighbour, so the cap keeps the paths from the most similar prior
 * work rather than an arbitrary slice. Ordering matters downstream: the
 * retrieval step sends this list to a store that has no relevance ranking, so
 * whatever leads the list is what a truncating consumer keeps.
 *
 * A neighbour below `similarityFloor` contributes nothing — not a smaller
 * contribution, none. A prediction assembled from tasks that are not actually
 * similar is worse than no prediction, because it displaces the regex step that
 * would otherwise have run.
 */
export function unionNeighbourPaths(
  neighbours: readonly NeighbourTask[],
  config: TaskAreaConfig,
): TaskAreaPredictionResult {
  const eligible = [...neighbours]
    .filter(n => Number.isFinite(n.score) && n.score >= config.similarityFloor)
    .sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const paths: string[] = [];
  const contributors: TaskAreaPredictionResult['contributors'] = [];
  let truncated = false;

  // Deliberately no early exit once `maxPaths` is reached: the loop keeps going
  // so `truncated` reflects whether a path was actually DROPPED. Stopping at
  // the cap would leave the flag false whenever the overflow lived in a
  // neighbour the loop never reached — which is most of the time. The eligible
  // list is at most `topK` long, so finishing it costs nothing.
  for (const neighbour of eligible) {
    let contributed = 0;
    for (const raw of neighbour.paths) {
      if (contributed >= config.maxPathsPerNeighbour) break;
      if (typeof raw !== 'string') continue;
      const path = stripTrailingSep(raw.trim());
      if (!path) continue;
      // A path already in the union is not an overflow — it is the same path.
      if (seen.has(path)) continue;
      if (paths.length >= config.maxPaths) {
        truncated = true;
        break;
      }
      seen.add(path);
      paths.push(path);
      contributed++;
    }
    if (contributed > 0) {
      contributors.push({ taskId: neighbour.taskId, score: neighbour.score, contributed });
    }
  }

  const scores = neighbours.map(n => n.score).filter(s => Number.isFinite(s));
  return {
    paths,
    contributors,
    considered: neighbours.length,
    topScore: scores.length > 0 ? Math.max(...scores) : null,
    truncated,
  };
}

// ── Carrying the prediction to the agent ──────────────────────────────────────

/** Key under `task.context` that the claim response mirrors the hint into. */
export const TASK_AREA_CONTEXT_KEY = 'predictedTaskArea';

/**
 * What rides to the runner on the claim payload.
 *
 * **Set only for the treatment arm, and only when there is something to say.**
 * That is deliberate: presence of this hint IS enrolment, so the runner needs
 * no arm logic, no fraction, and no second draw — and a control-arm session is
 * byte-identical to one built before this experiment existed, which is what
 * makes it a control.
 *
 * It is mirrored onto the in-memory claim response only. Nothing persists it to
 * `tasks.context`, and nothing anywhere copies it to `tasks.path_manifest`.
 */
export interface TaskAreaContextHint {
  arm: typeof TASK_AREA_TREATMENT_ARM;
  policyVersion: string;
  /** The predicted area — advisory. */
  paths: string[];
  source: NeighbourPathSource;
}

/**
 * Read the hint back off a claim payload's task context, defensively.
 *
 * `context` is jsonb with only a compile-time assertion about its shape, and
 * this runs inside a session that has already started — so every field is
 * checked rather than asserted. Anything malformed reads as "no hint", which
 * degrades to the control behaviour.
 */
export function readTaskAreaHint(context: unknown): TaskAreaContextHint | null {
  if (!context || typeof context !== 'object') return null;
  const raw = (context as Record<string, unknown>)[TASK_AREA_CONTEXT_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const hint = raw as Record<string, unknown>;
  if (hint.arm !== TASK_AREA_TREATMENT_ARM) return null;
  const paths = Array.isArray(hint.paths)
    ? hint.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : [];
  if (paths.length === 0) return null;
  return {
    arm: TASK_AREA_TREATMENT_ARM,
    policyVersion: typeof hint.policyVersion === 'string' ? hint.policyVersion : '',
    paths,
    source: hint.source === 'manifest' ? 'manifest' : 'diff',
  };
}

/**
 * The prompt block naming the predicted area.
 *
 * Written as an explicitly advisory hint, because that is what it is: an agent
 * that reads this as a scope declaration will stop looking outside it, and the
 * prediction is a union over other people's diffs. The wording exists to make
 * the block useful for narrowing a `codebase-memory` or `recall` query without
 * licensing "these are the files I am allowed to change".
 *
 * `cbmAvailable: false` drops the graph from that sentence. A task in the
 * CBM-withheld arm of the cbm_access experiment has no codebase-memory tools,
 * and telling it to query one is steering toward a tool it does not have.
 */
export function renderTaskAreaBlock(hint: TaskAreaContextHint, opts: { cbmAvailable?: boolean } = {}): string {
  const narrow = opts.cbmAvailable === false
    ? 'to narrow a `recall` query or your first file search, then verify. If the'
    : 'to narrow a `codebase-memory` or `recall` query first, then verify. If the';
  const sourceLabel = hint.source === 'diff'
    ? 'what those tasks actually changed'
    : 'the file scopes those tasks declared';
  return [
    '### Likely file area (predicted)',
    '',
    `Completed tasks similar to this one touched the paths below — ${sourceLabel}.`,
    '',
    ...hint.paths.map(p => `- \`${p}\``),
    '',
    'ADVISORY. This is a prediction from past work, not a declaration of scope:',
    'it is not this task\'s path manifest, it does not constrain what you may',
    'change, and it is not evidence that any of these files is involved. Use it',
    narrow,
    'work is somewhere else, it is somewhere else.',
  ].join('\n');
}

// ── The one number ────────────────────────────────────────────────────────────

/**
 * Does a predicted path cover an actual one?
 *
 * Exact match, or either being a directory prefix of the other — the same rule
 * as `memoryFilesMatch` and `pathsOverlap`, so "these paths overlap" has one
 * definition in this repo rather than three. The symmetry matters here: a
 * prediction of `packages/core` covers an actual `packages/core/db/schema.ts`,
 * and a prediction of `apps/web/src/lib/foo.ts` is covered by an actual
 * `apps/web/src/lib`. Both predictors emit directories (`inferPathsFromText`
 * matches a bare `packages/core`; a neighbour's manifest often declares globs'
 * parent dirs), so applying the rule to only one of them would decide the
 * comparison by a technicality.
 */
export function pathCovers(predicted: string, actual: string): boolean {
  const p = stripTrailingSep(predicted);
  const a = stripTrailingSep(actual);
  if (!p || !a) return false;
  return p === a || a.startsWith(p + '/') || p.startsWith(a + '/');
}

export interface PathOverlap {
  /** Predicted paths, after normalisation and de-duplication. */
  predicted: number;
  /** Actual paths, after normalisation and de-duplication. */
  actual: number;
  /** Actual paths covered by at least one predicted path, over `actual`. The headline. */
  recall: number;
  /** Predicted paths that covered at least one actual path, over `predicted`. */
  precision: number;
  /** Actual paths matched EXACTLY by a predicted path, over `actual`. */
  exactRecall: number;
  /** True when there was nothing to score against — no actual paths recorded. */
  unscorable: boolean;
}

function normalizePaths(paths: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(paths)) return [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const p = stripTrailingSep(raw.trim());
    if (p) seen.add(p);
  }
  return [...seen];
}

/**
 * Overlap between a predicted area and the paths the task's diff actually
 * touched.
 *
 * Recall is the headline because the question the prediction exists to answer
 * is "did we scope retrieval to the right part of the repo" — an actual file
 * the prediction missed is a memory the prompt could not have found. Precision
 * is reported alongside it and is not decoration: recall alone is trivially
 * gamed by predicting the whole repo, and the two predictors being compared
 * emit different numbers of paths, so a recall win on twice the paths is not a
 * win. `predicted` is carried through for the same reason.
 *
 * `unscorable` (no actual paths) is a distinct state, not a zero. A task that
 * changed no files cannot tell you anything about either predictor, and
 * averaging it in as 0% would make the metric a function of how many
 * research/coordination tasks happened to be in the window.
 */
export function pathAreaOverlap(
  predictedPaths: readonly unknown[] | null | undefined,
  actualPaths: readonly unknown[] | null | undefined,
): PathOverlap {
  const predicted = normalizePaths(predictedPaths);
  const actual = normalizePaths(actualPaths);

  if (actual.length === 0) {
    return { predicted: predicted.length, actual: 0, recall: 0, precision: 0, exactRecall: 0, unscorable: true };
  }
  if (predicted.length === 0) {
    return { predicted: 0, actual: actual.length, recall: 0, precision: 0, exactRecall: 0, unscorable: false };
  }

  const actualSet = new Set(actual);
  let covered = 0;
  let exact = 0;
  for (const a of actual) {
    if (predicted.some(p => pathCovers(p, a))) covered++;
    if (predicted.includes(a)) exact++;
  }
  let useful = 0;
  for (const p of predicted) {
    if (actualSet.has(p) || actual.some(a => pathCovers(p, a))) useful++;
  }

  return {
    predicted: predicted.length,
    actual: actual.length,
    recall: covered / actual.length,
    precision: useful / predicted.length,
    exactRecall: exact / actual.length,
    unscorable: false,
  };
}
