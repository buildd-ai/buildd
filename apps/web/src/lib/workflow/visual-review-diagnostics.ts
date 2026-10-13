/**
 * "Report a Buildd problem": a short, sanitized note about a visual check that
 * failed to run. Pure. It is not a visual finding: findings are about the
 * product's screens and live in the review; this is about the check itself, so
 * it carries the cause, the stage, the policy and the short ids, and never a
 * link, a token, an address or free text a person typed without redaction.
 */
import type { MissionVisualReviewState } from './visual-review-state';

const MAX_LENGTH = 600;

const PATTERNS: Array<[RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"<>]+/gi, '[link removed]'],
  [/\bwww\.[^\s)'"<>]+/gi, '[link removed]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[removed]'],
  [/\b(?:bld|ghp|gho|ghs|ghu|github_pat|sk|pk|xox[abprs]|npm|vercel)[_-][A-Za-z0-9_-]{8,}/gi, '[removed]'],
  [/\bAKIA[0-9A-Z]{12,}\b/g, '[removed]'],
  [/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)*/g, '[removed]'],
  [/\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, '[removed]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[address removed]'],
  // Long opaque strings (hashes, base64): a short sha (up to 12) stays readable.
  [/\b[A-Za-z0-9+/_=-]{25,}\b/g, '[removed]'],
];

export function redactDiagnosticText(text: string): string {
  let out = text;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_LENGTH ? `${out.slice(0, MAX_LENGTH - 1)}…` : out;
}

export interface ProblemReport {
  title: string;
  body: string;
}

const TITLE: Record<string, string> = {
  preview_unavailable: 'Visual check preview unavailable',
  capture_auth: 'Visual check preview needs access',
};

/** Null unless the state is a system failure: a product finding is never reported this way. */
export function buildProblemReport(state: MissionVisualReviewState, opts: { note?: string | null }): ProblemReport | null {
  if (state.status !== 'blocked' || !state.blocked) return null;
  const lines = [
    `Cause: ${state.blocked.cause}`,
    `Owner of the cause: ${state.blocked.causeOwner}`,
    `Automatic retries left: ${state.blocked.autoRetriesLeft}`,
    `Policy: ${state.policy.mode}`,
    ...(state.auditTaskId ? [`Check: ${state.auditTaskId.slice(0, 8)}`] : []),
    ...(state.branch.headSha ? [`Head: ${state.branch.headSha.slice(0, 7)}`] : []),
    ...(state.branch.integrationPr ? [`Integration PR: #${state.branch.integrationPr.number}`] : []),
  ];
  const note = opts.note ? redactDiagnosticText(opts.note) : '';
  if (note) lines.push(`Note: ${note}`);
  return { title: TITLE[state.blocked.cause] ?? 'Visual check could not run', body: lines.join('\n') };
}
