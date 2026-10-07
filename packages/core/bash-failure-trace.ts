/**
 * The shape of a "Bash exited non-zero" error trace, shared by the runner that
 * writes it and the server that turns it into `result.evidence`.
 *
 * The trace rides the existing `worker_error_traces` row (pattern + excerpt +
 * source), so no column is added: the first excerpt line carries the redacted
 * command and exit code, the rest is a short tail of the output.
 *
 *   $ bun test apps/web/foo.test.ts [exit 1]
 *   (fail) foo > does the thing
 *   error: expect(received).toBe(expected)
 */

export const BASH_FAILURE_PATTERN = 'bash_nonzero_exit';
/** A verify command (test / typecheck / lint) that passed after an earlier failure of the same family. */
export const BASH_RECOVERED_PATTERN = 'bash_verify_recovered';

/** Lines of output kept after the header. */
export const BASH_TRACE_TAIL_LINES = 60;
/** Hard cap on one excerpt, header included. The server clamps to the same number. */
export const BASH_TRACE_EXCERPT_MAX = 6000;
/**
 * The command is kept whole (redacted by the caller) so an error opened on the
 * task page shows exactly what ran. Multi-line commands are joined with ` ⏎ `
 * so the header stays one line. Bounded so the output tail keeps its room.
 */
const COMMAND_MAX = 1500;
const LINE_JOIN = ' ⏎ ';
const LINE_MAX = 200;

export type VerifyFamily = 'test' | 'typecheck' | 'lint';

const FAMILY_PATTERNS: Array<[VerifyFamily, RegExp]> = [
  ['typecheck', /(?:^|[\s;&|(])(?:tsc|tsgo|(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:type-?check|tsc|check-types))(?:\s|$)/],
  ['lint', /(?:^|[\s;&|(])(?:eslint|biome|prettier|(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?lint\S*)(?:\s|$)|\bratchet\b/],
  ['test', /(?:^|[\s;&|(])(?:bun\s+(?:run\s+)?test\S*|bun\s+run\s+scripts\/run-unit-tests\S*|vitest|jest|pytest|(?:npm|pnpm|yarn)\s+(?:run\s+)?test\S*)(?:\s|$)|run-unit-tests/],
];

/** Which kind of check a command is, or null when it is not one. */
export function verifyFamilyOf(command: string): VerifyFamily | null {
  for (const [family, re] of FAMILY_PATTERNS) if (re.test(command)) return family;
  return null;
}

/** The exit code the Bash tool prefixes onto a failing result ("Exit code 1"), or null. */
export function parseExitCode(resultText: string): number | null {
  const m = /^Exit code (\d+)\b/.exec(resultText);
  return m ? Number(m[1]) : null;
}

/** The output after the tool's own "Exit code N" line. */
export function stripExitCodeLine(resultText: string): string {
  return resultText.replace(/^Exit code \d+\r?\n?/, '');
}

function oneLine(command: string): string {
  const joined = command.split('\n').map(l => l.trim()).filter(l => l !== '').join(LINE_JOIN);
  return joined.length > COMMAND_MAX ? `${joined.slice(0, COMMAND_MAX)}…` : joined;
}

export function formatBashTraceExcerpt(input: {
  command: string;
  exitCode: number | null;
  output: string;
}): string {
  const header = `$ ${oneLine(input.command)} [exit ${input.exitCode ?? '?'}]`;
  const tail = input.output
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l !== '')
    .slice(-BASH_TRACE_TAIL_LINES)
    .map(l => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l));
  // Drop from the front so the failing end of the output survives the cap.
  let body = tail.join('\n');
  const room = BASH_TRACE_EXCERPT_MAX - header.length - 1;
  if (body.length > room) body = body.slice(body.length - room);
  return body ? `${header}\n${body}` : header;
}

export interface ParsedBashTrace {
  command: string;
  exitCode: number | null;
  output: string;
}

export function parseBashTraceExcerpt(excerpt: string): ParsedBashTrace | null {
  const nl = excerpt.indexOf('\n');
  const head = nl === -1 ? excerpt : excerpt.slice(0, nl);
  const m = /^\$ (.*) \[exit (\d+|\?)\]$/.exec(head);
  if (!m) return null;
  return {
    command: m[1],
    exitCode: m[2] === '?' ? null : Number(m[2]),
    output: nl === -1 ? '' : excerpt.slice(nl + 1),
  };
}
