/**
 * Experiments — the pure half of the operator surface (REST + MCP + /app/health).
 * No db, no clock: every decision here takes its inputs as arguments so it is
 * tested directly, and the routes stay thin.
 *
 * Two rules carry the weight:
 *
 * - **Visibility is existence.** An experiment with `visibility: 'admins'` is
 *   not merely read-protected from members, it does not exist for them: every
 *   read and write path answers 404, never 403, so a member cannot probe which
 *   keys or ids are in use. `canViewExperiment` is the one predicate for that.
 * - **Settings that shape the draw are versioned.** The randomiser salts with
 *   `policyVersion` (packages/core/experiment-randomizer.ts) and the readout
 *   filters on it (packages/core/experiment-readout-source.ts). Changing the
 *   treatment fraction or config after the experiment first started therefore
 *   bumps the version — rows drawn under the old settings are analysed apart
 *   from rows drawn under the new ones instead of being pooled into a mixture.
 *   Paused counts as "started": units drawn before the pause still sit under
 *   the old version when it resumes.
 */
import type {
  CreateExperimentInput,
  Experiment,
  ExperimentKind,
  ExperimentStatus,
  ExperimentVisibility,
  UpdateExperimentInput,
} from '@buildd/shared';
import { defaultCbmAccessConfig } from '@buildd/core/cbm-access-experiment';

export type TeamRole = 'owner' | 'admin' | 'member';

export const EXPERIMENT_STATUSES: readonly ExperimentStatus[] = ['draft', 'running', 'paused', 'concluded'];
export const EXPERIMENT_VISIBILITIES: readonly ExperimentVisibility[] = ['admins', 'team'];
export const EXPERIMENT_KINDS = ['model_routing', 'cbm_access'] as const satisfies readonly ExperimentKind[];

/** Legal status moves. `concluded` is terminal. */
export const EXPERIMENT_TRANSITIONS: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  draft: ['running', 'concluded'],
  running: ['paused', 'concluded'],
  paused: ['running', 'concluded'],
  concluded: [],
};

export function isExperimentAdmin(role: TeamRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function canViewExperiment(visibility: string, role: TeamRole | null | undefined): boolean {
  return visibility === 'team' || isExperimentAdmin(role);
}

/**
 * The config a new model-routing experiment gets when the caller sends none —
 * the same values `parseModelRoutingConfig` falls back to, written out so the
 * row says what it will do instead of relying on code defaults.
 */
export function defaultModelRoutingConfig(): Record<string, unknown> {
  return {
    arms: { control: 'as_routed', treatment: { tier: 'premium' } },
    eligibility: { maxBudgetPressure: 0.5 },
    minSamplePerArm: 30,
  };
}

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TITLE_MAX = 200;
const TEXT_MAX = 4000;

type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 409; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Strictly between 0 and 1: 0 and 1 are not experiments, they are rollouts. */
function validFraction(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1;
}

function optText(v: unknown, field: string): Result<string | null | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, status: 400, error: `${field} must be a string` };
  const t = v.trim();
  if (t.length > TEXT_MAX) return { ok: false, status: 400, error: `${field} is too long` };
  return { ok: true, value: t === '' ? null : t };
}

export interface NewExperimentValues {
  key: string;
  title: string;
  hypothesis: string | null;
  kind: ExperimentKind;
  treatmentFraction: number;
  config: Record<string, unknown>;
  visibility: ExperimentVisibility;
}

export function parseCreateExperiment(body: unknown): Result<NewExperimentValues> {
  if (!isPlainObject(body)) return { ok: false, status: 400, error: 'Body must be a JSON object' };
  const b = body as Partial<CreateExperimentInput> & Record<string, unknown>;

  if (typeof b.key !== 'string' || !KEY_RE.test(b.key)) {
    return { ok: false, status: 400, error: 'key must be 1-64 chars of a-z, 0-9, "-" or "_", starting with a letter or digit' };
  }
  if (typeof b.title !== 'string' || !b.title.trim()) return { ok: false, status: 400, error: 'title is required' };
  if (b.title.trim().length > TITLE_MAX) return { ok: false, status: 400, error: 'title is too long' };

  const hyp = optText(b.hypothesis, 'hypothesis');
  if (!hyp.ok) return hyp;

  const kind = b.kind ?? 'model_routing';
  if (!(EXPERIMENT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, status: 400, error: `kind must be one of ${EXPERIMENT_KINDS.join(', ')}` };
  }

  // cbm_access has no implicit share: withholding the graph from half the
  // fleet because a caller omitted a field is not a safe default. The operator
  // names the share (e.g. 0.2) explicitly, or the create is refused.
  if (kind === 'cbm_access' && b.treatmentFraction === undefined) {
    return { ok: false, status: 400, error: 'treatmentFraction is required for kind cbm_access (the share of eligible tasks that run WITHOUT CBM, e.g. 0.2)' };
  }
  const fraction = b.treatmentFraction ?? 0.5;
  if (!validFraction(fraction)) return { ok: false, status: 400, error: 'treatmentFraction must be a number strictly between 0 and 1' };

  if (b.config !== undefined && !isPlainObject(b.config)) return { ok: false, status: 400, error: 'config must be an object' };

  const visibility = b.visibility ?? 'admins';
  if (!EXPERIMENT_VISIBILITIES.includes(visibility)) return { ok: false, status: 400, error: 'visibility must be "admins" or "team"' };

  return {
    ok: true,
    value: {
      key: b.key,
      title: b.title.trim(),
      hypothesis: hyp.value ?? null,
      kind: kind as ExperimentKind,
      treatmentFraction: fraction,
      config: (b.config as Record<string, unknown> | undefined)
        ?? (kind === 'cbm_access' ? defaultCbmAccessConfig() : defaultModelRoutingConfig()),
      visibility,
    },
  };
}

/** The fields of the stored row a patch is planned against. */
export interface ExperimentState {
  status: ExperimentStatus;
  treatmentFraction: number;
  policyVersion: number;
  config: Record<string, unknown>;
  startedAt: Date | null;
  decision: string | null;
}

export interface ExperimentPatchPlan {
  set: Record<string, unknown>;
  /** Target status when the patch moves it, else null. */
  transition: ExperimentStatus | null;
  bumpedPolicyVersion: boolean;
}

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` do not bump the version. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function planExperimentPatch(current: ExperimentState, body: unknown, now: Date): Result<ExperimentPatchPlan> {
  if (!isPlainObject(body)) return { ok: false, status: 400, error: 'Body must be a JSON object' };
  const b = body as UpdateExperimentInput & Record<string, unknown>;

  if (current.status === 'concluded') {
    return { ok: false, status: 409, error: 'Experiment is concluded; concluded is terminal' };
  }
  for (const immutable of ['key', 'kind', 'policyVersion', 'startedAt', 'concludedAt', 'teamId', 'id']) {
    if (immutable in b) return { ok: false, status: 400, error: `${immutable} cannot be changed` };
  }

  const set: Record<string, unknown> = {};

  if (b.title !== undefined) {
    if (typeof b.title !== 'string' || !b.title.trim()) return { ok: false, status: 400, error: 'title must be a non-empty string' };
    if (b.title.trim().length > TITLE_MAX) return { ok: false, status: 400, error: 'title is too long' };
    set.title = b.title.trim();
  }
  const hyp = optText(b.hypothesis, 'hypothesis');
  if (!hyp.ok) return hyp;
  if (hyp.value !== undefined) set.hypothesis = hyp.value;

  if (b.visibility !== undefined) {
    if (!EXPERIMENT_VISIBILITIES.includes(b.visibility)) return { ok: false, status: 400, error: 'visibility must be "admins" or "team"' };
    set.visibility = b.visibility;
  }

  let drawChanged = false;
  if (b.treatmentFraction !== undefined) {
    if (!validFraction(b.treatmentFraction)) return { ok: false, status: 400, error: 'treatmentFraction must be a number strictly between 0 and 1' };
    if (b.treatmentFraction !== current.treatmentFraction) {
      set.treatmentFraction = b.treatmentFraction;
      drawChanged = true;
    }
  }
  if (b.config !== undefined) {
    if (!isPlainObject(b.config)) return { ok: false, status: 400, error: 'config must be an object' };
    if (stableStringify(b.config) !== stableStringify(current.config)) {
      set.config = b.config;
      drawChanged = true;
    }
  }

  let transition: ExperimentStatus | null = null;
  if (b.status !== undefined && b.status === current.status) {
    return { ok: false, status: 409, error: `Experiment is already ${current.status}` };
  }
  if (b.status !== undefined) {
    if (!EXPERIMENT_STATUSES.includes(b.status)) return { ok: false, status: 400, error: `status must be one of ${EXPERIMENT_STATUSES.join(', ')}` };
    if (!EXPERIMENT_TRANSITIONS[current.status].includes(b.status)) {
      return { ok: false, status: 409, error: `Cannot move an experiment from ${current.status} to ${b.status}` };
    }
    transition = b.status;
  }

  if (b.decision !== undefined) {
    if (transition !== 'concluded') return { ok: false, status: 400, error: 'decision can only be set when concluding (status: "concluded")' };
  }
  if (transition === 'concluded') {
    if (typeof b.decision !== 'string' || !b.decision.trim()) {
      return { ok: false, status: 400, error: 'Concluding requires a decision: what was decided and why' };
    }
    if (b.decision.trim().length > TEXT_MAX) return { ok: false, status: 400, error: 'decision is too long' };
    set.status = 'concluded';
    set.decision = b.decision.trim();
    set.concludedAt = now;
  } else if (transition) {
    set.status = transition;
    // First start stamps startedAt; a resume keeps the original start.
    if (transition === 'running' && !current.startedAt) set.startedAt = now;
  }

  const started = current.status !== 'draft';
  const bumpedPolicyVersion = started && drawChanged;
  if (bumpedPolicyVersion) set.policyVersion = current.policyVersion + 1;

  if (Object.keys(set).length === 0) return { ok: false, status: 400, error: 'Nothing to update' };
  set.updatedAt = now;

  return { ok: true, value: { set, transition, bumpedPolicyVersion } };
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/** Row → API shape. Deliberately omits teamId and createdBy. */
export function toExperimentDTO(row: {
  id: string; key: string; title: string; hypothesis: string | null; status: string; kind: string;
  treatmentFraction: number | string; policyVersion: number; config: unknown; visibility: string;
  decision: string | null; startedAt: Date | string | null; concludedAt: Date | string | null;
  createdAt: Date | string; updatedAt: Date | string;
}): Experiment {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    hypothesis: row.hypothesis,
    status: row.status as ExperimentStatus,
    kind: row.kind as Experiment['kind'],
    treatmentFraction: Number(row.treatmentFraction),
    policyVersion: row.policyVersion,
    config: isPlainObject(row.config) ? row.config : {},
    visibility: row.visibility as ExperimentVisibility,
    decision: row.decision,
    startedAt: iso(row.startedAt),
    concludedAt: iso(row.concludedAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}
