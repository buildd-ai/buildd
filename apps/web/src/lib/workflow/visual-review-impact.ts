/**
 * Visual-review impact assessment: does the mission's integration branch change
 * anything a person can see, so that it owes a visual review? Pure apart from
 * the injected `decide` port.
 *
 * Owner decision (docs/specs/mission-task-lifecycle.md, "Visual review"): code
 * decides first, Jev only the ambiguous remainder, and never a human prompt.
 * Order: policy -> diff readable -> deterministic rules -> bounded Jev decision
 * (`buildd.visual_impact`, packages/core/decision-kind-visual-impact.ts) ->
 * fail-safe. Every path that cannot prove "no visual impact" answers
 * `review_required`.
 *
 * A `not_applicable` verdict here is an *applicability* record about one head
 * SHA. It is not a waiver: waivers are a person's recorded skip
 * (`loadSurfaceAuditWaiver`) and are stored and shown separately.
 */
import { isRenderedSurfaceChange, isUiSurfacePath } from '@buildd/core/surface-audit';
import {
  VISUAL_IMPACT_CONFIG,
  visualImpactReasonOf,
  type VisualImpactDecision,
  type VisualImpactFeatures,
  type VisualImpactReason,
} from '@buildd/core/decision-kind-visual-impact';
import type { ResolvedVisualReviewPolicy } from './visual-review-policy';
import type { VisualReviewStateInput } from './visual-review-state';

export interface ImpactFile {
  path: string;
  /** Unified diff text; absent for binary or very large files. */
  patch?: string | null;
}

export type ImpactCategory =
  | 'style' // stylesheets, tokens, theme and tailwind config
  | 'screen' // route-level page / layout files
  | 'risky_flow' // auth, onboarding, checkout... screens and components
  | 'candidate' // UI-adjacent code the rules cannot rule out
  | 'no_render'; // tests, types, docs, comments, server-only code, everything else

export type ImpactReasonCode =
  | 'policy_off'
  | 'no_render_files'
  | 'no_render_changes'
  | 'protected_style'
  | 'protected_screen'
  | 'protected_flow'
  | 'strict_no_model_skip'
  | 'model_no_visual_impact'
  | 'model_review_required'
  | 'model_insufficient_evidence'
  | 'model_low_confidence'
  | 'model_error'
  | 'diff_unavailable'
  | 'diff_incomplete'
  | 'head_unknown';

export interface ImpactReason {
  code: ImpactReasonCode;
  /** The model's closed reason, when a model answered. */
  modelReason?: VisualImpactReason;
}

export type ImpactBasis = 'policy' | 'rule' | 'model' | 'fail_safe';

export interface VisualImpactAssessment {
  /** Always an applicability record; never a waiver. */
  recordKind: 'applicability';
  verdict: 'review_required' | 'not_applicable';
  basis: ImpactBasis;
  reasons: ImpactReason[];
  confidence: number | null;
  /** The integration branch head this was decided for. Stale on any other SHA. */
  headSha: string | null;
  policyMode: ResolvedVisualReviewPolicy['mode'];
  /** True: any new head SHA, a policy change or a requested audit overrides it. */
  reversible: true;
  evidence: {
    filesInspected: number;
    protectedFiles: number;
    ambiguousFiles: number;
    noRenderFiles: number;
    diffRead: boolean;
  };
}

// ── deterministic file classification ────────────────────────────────────────

const STYLE_RE = /\.(css|scss|sass|less|pcss)$/i;
const TOKEN_RE = /(^|\/)(tailwind\.config|postcss\.config)\.[a-z]+$|(^|\/)(design-)?tokens?(\.|\/)|(^|\/)theme(\.|\/)/i;
const SCREEN_RE = /(^|\/)app\/(.*\/)?(page|layout|template|loading|error|not-found|default)\.(tsx|jsx)$/;
const RISKY_FLOW_RE = /(^|\/)(auth|login|signup|sign-up|onboarding|checkout|billing|payments?|paywall)(\/|\.)/i;
const MARKUP_FILE_RE = /\.(tsx|jsx|vue|svelte|html|astro|mdx)$/i;
const NEVER_RENDERS_RE = /(\.(test|spec|stories)\.[a-z]+$|(^|\/)__(tests|mocks|snapshots)__\/|(^|\/)tests?\/|\.d\.ts$|\.(md|snap)$)/i;
const SERVER_ONLY_PATH_RE = /(^|\/)api\/|(^|\/)route\.(ts|js)$|(^|\/)(actions|middleware|proxy)\.(ts|js)$/;
const SERVER_ONLY_MARKER_RE = /^[ +-]\s*(import\s+['"]server-only['"]|['"]use server['"])/m;

/** Lines of a patch that were added or removed (not headers or context). */
function changedLines(patch: string): string[] {
  return patch.split('\n').filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---')).map(l => l.slice(1));
}

const COMMENT_OR_BLANK_RE = /^\s*(\/\/.*|\/\*.*|\*.*|\*\/.*|\{\/\*.*\*\/\}|)\s*$/;
const TYPE_ONLY_RE = /^\s*(import\s+type\b|export\s+type\b|export\s+interface\b|interface\b|type\s+\w+)/;

/** True when every changed line is a comment, blank, or a single-line type-only statement. */
function inertChangeOnly(patch: string): boolean {
  const lines = changedLines(patch);
  return lines.every(l => COMMENT_OR_BLANK_RE.test(l) || TYPE_ONLY_RE.test(l));
}

const MARKUP_LINE_RE = /<\/?[A-Za-z][\w.]*(\s|>|\/)|\bJSX\b/;
const STYLE_LINE_RE = /\b(className|class|style|sx|css)\s*=|\bclsx\(|\bcn\(|\btw`|\bstyled\b/;
const TEXT_LINE_RE = />[^<>{}]*[A-Za-z]{3,}[^<>{}]*<|\b(title|label|placeholder|alt|aria-label|children)\s*[:=]\s*['"`{][^'"`]*[A-Za-z]{3,}/;

/** Classify one file. Tests, types, docs, comments-only and server-only code never render. */
export function classifyImpactFile(file: ImpactFile): ImpactCategory {
  const path = file.path.replace(/^\/+/, '');
  if (NEVER_RENDERS_RE.test(path)) return 'no_render';
  if (STYLE_RE.test(path) || TOKEN_RE.test(path)) return 'style';

  const uiAdjacent = isUiSurfacePath(path) || MARKUP_FILE_RE.test(path) || RISKY_FLOW_RE.test(path);
  if (!uiAdjacent) return 'no_render';
  if (SERVER_ONLY_PATH_RE.test(path) && !MARKUP_FILE_RE.test(path)) return 'no_render';
  if (file.patch && SERVER_ONLY_MARKER_RE.test(file.patch)) return 'no_render';
  // Comment / type-only edits cannot move a pixel, wherever they sit.
  if (file.patch && inertChangeOnly(file.patch)) return 'no_render';

  if (SCREEN_RE.test(path) && isRenderedSurfaceChange(path)) return 'screen';
  if (RISKY_FLOW_RE.test(path) && MARKUP_FILE_RE.test(path)) return 'risky_flow';
  return 'candidate';
}

/** Bounded, content-free facts about the candidate files, for the Jev decision. */
export function impactFeatures(files: ImpactFile[], classified: ImpactCategory[], protectedHit: boolean): VisualImpactFeatures {
  const f: VisualImpactFeatures = {
    protectedHit,
    totalFiles: files.length,
    candidateFiles: 0,
    candidatesWithoutPatch: 0,
    addedLines: 0,
    removedLines: 0,
    markupLines: 0,
    styleLines: 0,
    textLines: 0,
  };
  files.forEach((file, i) => {
    if (classified[i] !== 'candidate') return;
    f.candidateFiles++;
    if (!file.patch) { f.candidatesWithoutPatch++; return; }
    for (const raw of file.patch.split('\n')) {
      if (raw.startsWith('+++') || raw.startsWith('---')) continue;
      const added = raw.startsWith('+');
      if (!added && !raw.startsWith('-')) continue;
      if (added) f.addedLines++; else f.removedLines++;
      const line = raw.slice(1);
      if (COMMENT_OR_BLANK_RE.test(line)) continue;
      if (MARKUP_LINE_RE.test(line)) f.markupLines++;
      if (STYLE_LINE_RE.test(line)) f.styleLines++;
      if (TEXT_LINE_RE.test(line)) f.textLines++;
    }
  });
  return f;
}

// ── assessment ───────────────────────────────────────────────────────────────

export interface ImpactDecisionAnswer {
  decision: VisualImpactDecision;
  confidence: number | null;
  reasonCode: string;
  /** `rule` and `fallback` are never a model's opinion. */
  source: 'rule' | 'model' | 'fallback';
}

/** The Jev port. The default goes through `runBuilddDecision` (visual-review-impact-load.ts). */
export type ImpactDecider = (features: VisualImpactFeatures) => Promise<ImpactDecisionAnswer>;

export interface AssessVisualImpactInput {
  policy: Pick<ResolvedVisualReviewPolicy, 'mode'>;
  /** Integration branch vs trunk. `null` = the diff could not be read. */
  files: ImpactFile[] | null;
  headSha: string | null;
  decide: ImpactDecider;
}

export async function assessVisualImpact(input: AssessVisualImpactInput): Promise<VisualImpactAssessment> {
  const { policy, files, headSha } = input;
  const base = { recordKind: 'applicability', reversible: true, headSha, policyMode: policy.mode } as const;
  const evidence = (over: Partial<VisualImpactAssessment['evidence']> = {}): VisualImpactAssessment['evidence'] => ({
    filesInspected: files?.length ?? 0, protectedFiles: 0, ambiguousFiles: 0, noRenderFiles: 0, diffRead: files !== null, ...over,
  });

  if (policy.mode === 'off') {
    return { ...base, verdict: 'not_applicable', basis: 'policy', reasons: [{ code: 'policy_off' }], confidence: null, evidence: evidence() };
  }
  if (files === null) {
    return { ...base, verdict: 'review_required', basis: 'fail_safe', reasons: [{ code: 'diff_unavailable' }], confidence: null, evidence: evidence() };
  }

  const cats = files.map(classifyImpactFile);
  const count = (c: ImpactCategory) => cats.filter(x => x === c).length;
  const protectedFiles = count('style') + count('screen') + count('risky_flow');
  const ambiguousFiles = count('candidate');
  const ev = evidence({ protectedFiles, ambiguousFiles, noRenderFiles: count('no_render') });

  if (protectedFiles > 0) {
    const reasons: ImpactReason[] = [];
    if (count('style')) reasons.push({ code: 'protected_style' });
    if (count('screen')) reasons.push({ code: 'protected_screen' });
    if (count('risky_flow')) reasons.push({ code: 'protected_flow' });
    return { ...base, verdict: 'review_required', basis: 'rule', reasons, confidence: null, evidence: ev };
  }

  if (ambiguousFiles === 0) {
    return {
      ...base,
      verdict: 'not_applicable',
      basis: 'rule',
      reasons: [{ code: files.some(f => isUiSurfacePath(f.path) || MARKUP_FILE_RE.test(f.path)) ? 'no_render_changes' : 'no_render_files' }],
      confidence: null,
      evidence: ev,
    };
  }

  const failSafe = (code: ImpactReasonCode, confidence: number | null = null, modelReason?: VisualImpactReason): VisualImpactAssessment => ({
    ...base, verdict: 'review_required', basis: 'fail_safe', reasons: [{ code, ...(modelReason ? { modelReason } : {}) }], confidence, evidence: ev,
  });

  // Strict never skips on a model's say-so; a skip with no SHA could never be invalidated.
  if (policy.mode === 'strict') return { ...failSafe('strict_no_model_skip'), basis: 'policy' };
  if (!headSha) return failSafe('head_unknown');

  const features = impactFeatures(files, cats, false);
  if (features.candidatesWithoutPatch > 0) return failSafe('diff_incomplete');

  let answer: ImpactDecisionAnswer;
  try {
    answer = await input.decide(features);
  } catch {
    return failSafe('model_error');
  }
  const modelReason = visualImpactReasonOf(answer.reasonCode) ?? undefined;
  if (answer.source !== 'model') return failSafe(/low_confidence/.test(answer.reasonCode) ? 'model_low_confidence' : 'model_error');
  const confidence = answer.confidence;
  if (answer.decision === 'insufficient_evidence') return failSafe('model_insufficient_evidence', confidence, modelReason);
  if (answer.decision === 'review_required') {
    return { ...base, verdict: 'review_required', basis: 'model', reasons: [{ code: 'model_review_required', ...(modelReason ? { modelReason } : {}) }], confidence, evidence: ev };
  }
  if (confidence === null || confidence < VISUAL_IMPACT_CONFIG.minConfidence) return failSafe('model_low_confidence', confidence, modelReason);
  return { ...base, verdict: 'not_applicable', basis: 'model', reasons: [{ code: 'model_no_visual_impact', ...(modelReason ? { modelReason } : {}) }], confidence, evidence: ev };
}

/** An assessment holds only for the head SHA it was made on. */
export function isImpactAssessmentCurrent(a: Pick<VisualImpactAssessment, 'headSha'> | null | undefined, headSha: string | null): boolean {
  return !!a && !!a.headSha && !!headSha && a.headSha === headSha;
}

/** The surface-audit-gate-shaped fact `deriveMissionVisualReview` reads. A stale assessment is `unknown`. */
export function uiChangeFromImpact(
  a: VisualImpactAssessment | null | undefined,
  headSha: string | null,
): VisualReviewStateInput['uiChange'] {
  if (a?.basis === 'policy' && a.verdict === 'not_applicable') return { state: 'no', source: null, uiFiles: 0 };
  if (!a || !isImpactAssessmentCurrent(a, headSha)) return { state: 'unknown', source: null, uiFiles: 0 };
  if (a.verdict === 'not_applicable') return { state: 'no', source: 'diff', uiFiles: 0 };
  return { state: 'yes', source: 'diff', uiFiles: a.evidence.protectedFiles + a.evidence.ambiguousFiles };
}
