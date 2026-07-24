const ANSI_PATTERN = /\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

export interface NormalizedCommandOutput {
  output: string;
  state?: 'pass' | 'fail';
  testSummary?: { passed: number; failed: number };
  failures: string[];
}

function cleanOutput(output: string): string {
  return output
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim();
}

function capMeaningfulTail(output: string, failures: string[], maxLength: number): string {
  if (output.length <= maxLength) return output;

  const tailLength = Math.max(0, maxLength - 2);
  let tail = output.slice(-tailLength);
  const firstLineBreak = tail.indexOf('\n');
  if (firstLineBreak >= 0) tail = tail.slice(firstLineBreak + 1);

  const missingFailures = failures.filter(failure => !tail.includes(failure));
  const prefix = missingFailures.length ? `${missingFailures.join('\n')}\n…\n` : '…\n';
  if (prefix.length + tail.length > maxLength) {
    tail = tail.slice(-(maxLength - prefix.length));
  }
  return `${prefix}${tail}`.slice(0, maxLength);
}

export function normalizeCommandOutput(
  rawOutput: string,
  command: string,
  maxLength = 8_000,
): NormalizedCommandOutput {
  const output = cleanOutput(rawOutput);
  const isBunTest = /\bbun(?:\s+run)?\s+test\b/.test(command);
  if (!isBunTest) {
    return { output: capMeaningfulTail(output, [], maxLength), failures: [] };
  }

  const failures = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^\(fail\)\s+/.test(line));

  const slashSummary = output.match(/(\d+)\s+pass(?:ed)?\s*\/\s*(\d+)\s+fail(?:ed)?/i);
  const passedMatch = output.match(/^\s*(\d+)\s+pass(?:ed)?\s*$/im);
  const failedMatch = output.match(/^\s*(\d+)\s+fail(?:ed)?\s*$/im);
  const testSummary = slashSummary
    ? { passed: Number(slashSummary[1]), failed: Number(slashSummary[2]) }
    : passedMatch || failedMatch
      ? { passed: Number(passedMatch?.[1] ?? 0), failed: Number(failedMatch?.[1] ?? 0) }
      : undefined;

  return {
    output: capMeaningfulTail(output, failures, maxLength),
    state: testSummary ? (testSummary.failed > 0 || failures.length > 0 ? 'fail' : 'pass') : undefined,
    testSummary,
    failures,
  };
}
