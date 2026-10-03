/**
 * The ref the visual auditor captures (docs/design/visual-qa-auditor.md, "Page
 * source" → "Which ref is captured"). Pure; no framework or DB imports.
 *
 * The pages must come from where the mission's work actually lives, which is
 * exactly the question `resolveTaskPrBase` answers for a task PR of the same
 * mission. So this is that function asked for a plain task, with trunk as the
 * only fallback — never a second derivation. A trunk default here shot a
 * mission-branch mission's pre-fix page and asked a person to judge it.
 */
import { resolveTaskPrBase, type MissionIntegrationFields } from './mission-integration';

/**
 * Why the capture ref is what it is. Recorded on every shot as
 * `metadata.qa.refSource`.
 *  - `mission_integration`: the mission's integration branch.
 *  - `integration_missing`: the mission has an integration branch, but it is
 *    gone from the remote, so trunk (only the live check can say this).
 *  - `trunk`: the mission has no integration base, or there is no mission.
 */
export type CaptureRefSource = 'mission_integration' | 'integration_missing' | 'trunk';

export const CAPTURE_REF_SOURCES: readonly CaptureRefSource[] = ['mission_integration', 'integration_missing', 'trunk'];

export interface CaptureRefResolution {
  /** A branch name. Null only when there is no integration base and no trunk was supplied. */
  ref: string | null;
  source: CaptureRefSource;
  /** The mission's integration branch, whether or not it is the answer. */
  integrationBase: string | null;
}

export function resolveVisualQaCaptureRef(args: {
  mission?: MissionIntegrationFields | null;
  /** The workspace trunk (`gitConfig.defaultBranch`). */
  trunk?: string | null;
  /** True when the integration branch is known to be absent on the remote. */
  integrationBaseMissing?: boolean;
}): CaptureRefResolution {
  const r = resolveTaskPrBase({
    mission: args.mission,
    task: null,
    fallbacks: [args.trunk],
    integrationBaseMissing: args.integrationBaseMissing,
  });
  const source: CaptureRefSource = r.enforced
    ? 'mission_integration'
    : r.integrationBase && args.integrationBaseMissing
      ? 'integration_missing'
      : 'trunk';
  return { ref: r.base, source, integrationBase: r.integrationBase };
}

/**
 * The workspace trunk a capture falls back to: the same order the PR route's
 * fallbacks use (`targetBranch`, `defaultBranch`, the repo's own default).
 */
export function captureTrunk(
  gitConfig: { targetBranch?: unknown; defaultBranch?: unknown } | null | undefined,
  repoDefaultBranch?: string | null,
): string | null {
  for (const c of [gitConfig?.targetBranch, gitConfig?.defaultBranch, repoDefaultBranch]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** A branch name as recorded on a shot: `origin/` and `refs/heads/` dropped. Null for a sha or nothing. */
export function normalizeCaptureRef(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const r = ref.trim().replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  if (!r || SHA_RE.test(r)) return null;
  return r;
}

/**
 * Was a shot captured from the mission's capture ref?
 *
 * `unknown` is never treated as wrong: a shot that recorded no ref (every shot
 * before this existed), a sha, no expected ref, or a trunk shot the server
 * sourced as `integration_missing` (which only the live check could know).
 */
export function captureRefMatch(
  qa: { ref?: unknown; refSource?: unknown },
  expectedRef: string | null | undefined,
): 'match' | 'mismatch' | 'unknown' {
  const expected = normalizeCaptureRef(expectedRef);
  const ref = normalizeCaptureRef(qa.ref);
  if (!expected || !ref) return 'unknown';
  if (ref === expected) return 'match';
  if (qa.refSource === 'integration_missing') return 'unknown';
  return 'mismatch';
}
