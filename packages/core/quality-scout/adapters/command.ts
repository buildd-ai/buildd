/**
 * Command / CLI-contract adapter: the port shape, the expectation parser, the
 * never-run list and the judge. Planning and gathering stay in `../executors`.
 */

import type { VerificationObservation } from '../../verification-check';
import { CLAUSE_SPLIT, CONTAINS, evidenceRefs, tail } from './shared';

/** The evidence key a command run produces. */
export const COMMAND_EVIDENCE_KEY = 'command-output';

export interface ScoutCommandRequest {
  command: string;
  timeoutMs: number;
  /** The candidate the command must run against — a throwaway checkout of it. */
  ref: string;
  sha: string;
}

export interface ScoutCommandOutput {
  /** Null when the process never reported one (killed, failed to spawn). */
  exitCode: number | null;
  timedOut: boolean;
  durationMs?: number;
  stdoutTail?: string;
  stderrTail?: string;
  /** Where the full output is stored. Absent: the evidence is only partial. */
  evidenceRef?: string | null;
}

export interface ScoutCommandExpectation {
  exit: number | 'nonzero';
  outputIncludes?: string;
}

/** `journey.expect` → a command expectation. Null when any clause is not understood: we never guess. */
export function parseCommandExpectation(raw: string | undefined): ScoutCommandExpectation | null {
  const out: ScoutCommandExpectation = { exit: 0 };
  if (raw === undefined || !raw.trim()) return out;
  for (const clause of raw.trim().split(CLAUSE_SPLIT).filter(Boolean)) {
    let m: RegExpMatchArray | null;
    if (/^(?:succeeds?|success|passes|ok|exits?\s+(?:cleanly|successfully))$/i.test(clause)) out.exit = 0;
    else if (/^(?:fails?|exits?\s+non-?zero|non-?zero(?:\s+exit)?)$/i.test(clause)) out.exit = 'nonzero';
    else if ((m = clause.match(/^(?:exits?|exit\s+code|exit\s+status)\s+(\d{1,3})$/i))) out.exit = Number(m[1]);
    else if ((m = clause.match(CONTAINS))) out.outputIncludes = m[1];
    else return null;
  }
  return out;
}

/**
 * Commands a probe never runs, whatever the workspace declared: writes to the
 * remote, merges, releases and deploys, schema pushes against a real database,
 * and anything that silently rewrites code or snapshots. Conservative on
 * purpose — a false refusal costs a person one look; a false run cannot be undone.
 */
export const SCOUT_UNSAFE_COMMAND_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'git_write', pattern: /\bgit\s+(?:push|merge|rebase|commit|reset|tag|cherry-pick|am|apply|checkout|switch|stash|clean|restore)\b/i },
  { id: 'forge_write', pattern: /\bgh\s+(?:pr|release|workflow|repo|issue|secret|variable|run)\s+(?:merge|create|close|edit|delete|run|rerun|reopen|ready|review|comment|set|upload|cancel)\b/i },
  { id: 'forge_api_write', pattern: /\bgh\s+api\b.*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b/i },
  { id: 'publish', pattern: /\b(?:npm|pnpm|yarn|bun|cargo|gem|twine|poetry|dotnet\s+nuget)\s+(?:publish|release|upload|push)\b/i },
  {
    id: 'deploy',
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy\b|\bvercel\b.*--prod\b|\bwrangler\s+(?:deploy|publish)\b|\bkubectl\s+(?:apply|delete|rollout)\b|\bterraform\s+(?:apply|destroy)\b|\bhelm\s+(?:install|upgrade|uninstall)\b|\bfly\s+deploy\b/i,
  },
  {
    id: 'schema_write',
    pattern: /\bdb:(?:push|migrate)\b|\bdrizzle-kit\s+(?:push|migrate)\b|\bprisma\s+(?:db\s+push|migrate\s+(?:deploy|dev|reset))\b|\balembic\s+(?:upgrade|downgrade)\b|\brails\s+db:|\bmanage\.py\s+migrate\b/i,
  },
  { id: 'auto_fix', pattern: /--fix\b|--write\b|--update-?snapshots?\b|--updateSnapshot\b|\bgofmt\s+-w\b|\bcargo\s+fix\b|\bgo\s+mod\s+tidy\b/i },
  { id: 'http_write', pattern: /\b(?:curl|wget|http|httpie)\b.*(?:-X|--request|--method)\s*(?:POST|PUT|PATCH|DELETE)\b|\bcurl\b.*\s(?:-d|--data(?:-\w+)?|-F|--form)\s/i },
];

export function unsafeCommandRule(command: string): string | null {
  return SCOUT_UNSAFE_COMMAND_RULES.find((r) => r.pattern.test(command))?.id ?? null;
}

/** Judge one command run against its expectation. Synchronous substrate executor body. */
export function judgeCommand({ expect, output }: { expect: ScoutCommandExpectation; output: ScoutCommandOutput | null }): VerificationObservation {
  if (!output) return { verdict: 'inconclusive', observed: 'The command produced no result.' };
  const refs = evidenceRefs(COMMAND_EVIDENCE_KEY, output.evidenceRef);
  if (output.timedOut) return { verdict: 'inconclusive', observed: `Timed out after ${output.durationMs ?? '?'}ms.`, evidenceRefs: refs };
  if (output.exitCode === null) return { verdict: 'inconclusive', observed: 'The process reported no exit code.', evidenceRefs: refs };
  const { exit, outputIncludes } = expect;
  const exitOk = exit === 'nonzero' ? output.exitCode !== 0 : output.exitCode === exit;
  const text = `${output.stdoutTail ?? ''}\n${output.stderrTail ?? ''}`;
  const outputOk = outputIncludes === undefined || text.includes(outputIncludes);
  const summary = `exit ${output.exitCode} (expected ${exit === 'nonzero' ? 'non-zero' : exit})${outputIncludes !== undefined ? `; output ${outputOk ? 'includes' : 'lacks'} "${outputIncludes}"` : ''}`;
  if (exitOk && outputOk) return { verdict: 'pass', observed: summary, evidenceRefs: refs, confidence: 1 };
  const err = tail(output.stderrTail) || tail(output.stdoutTail);
  return {
    verdict: 'fail',
    observed: err ? `${summary}; ${err}` : summary,
    evidenceRefs: refs,
    confidence: 1,
    signatureParts: [exitOk ? 'output-mismatch' : `exit:${output.exitCode}`],
  };
}
