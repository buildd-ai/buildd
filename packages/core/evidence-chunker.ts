/**
 * Log-aware chunker for the `evidence` corpus
 * (docs/specs/byo-evidence-storage.md, "The `evidence` corpus").
 *
 * An evidence object is a whole log: a failing command's output, a test report,
 * a CI job log. Embedding it whole would drown the failure in setup noise and
 * send far more text to the embedder than anyone searches for. This keeps only
 * the error-bearing signal:
 *
 *   - failing tests, each with its assertion and stack (bun `(fail)`, jest `●`);
 *   - error blocks with their stack frames, compiler errors;
 *   - a failing command's tail (a `command_output` object is non-zero by
 *     construction: it is only written for an `is_error` tool result);
 *   - the CI failure digest and the final agent summary, when the caller has them.
 *
 * Splits on test and file boundaries, dedupes, caps chunks per object, and runs
 * a second redaction pass on every chunk before it can reach the embedder.
 *
 * Pure: no I/O, no DB. The indexer (apps/web/src/lib/evidence-indexer.ts) reads
 * the object and writes the chunks.
 */
import { createSecretRedactor } from './redaction';

export const DEFAULT_MAX_EVIDENCE_CHUNKS = 40;
export const MAX_EVIDENCE_CHUNK_CHARS = 2000;
/** Lines kept from a failing command's end. */
export const COMMAND_TAIL_LINES = 30;
/** Most lines a single test or error block carries (the end, where the assertion is). */
const MAX_BLOCK_LINES = 40;
/** Most stack/context lines following an error line. */
const MAX_CONTINUATION_LINES = 25;

export type EvidenceErrorClass =
  | 'ci_digest'
  | 'summary'
  | 'test_failure'
  | 'type_error'
  | 'exception'
  | 'error'
  | 'command_tail';

export interface EvidenceChunk {
  content: string;
  errorClass: EvidenceErrorClass;
  testName?: string;
  file?: string;
}

export interface EvidenceChunkerInput {
  /** The decoded, already-redacted object body. */
  text: string;
  kind: string;
  /** A CI failure digest (extractFailureDigest), indexed as its own chunk. */
  digest?: string | null;
  /** The task's final agent summary. */
  summary?: string | null;
  maxChunks?: number;
  /** Extra exact values for the second redaction pass. */
  secretValues?: string[];
}

// CSI, OSC and two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** GitHub Actions prefixes every line with an ISO timestamp. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
/** Restates an exit code; crowds out the line that names the cause. */
const USELESS = /Process completed with exit code \d+/;

/** bun prints `path/to/x.test.ts:` on its own line before that file's results. */
const FILE_HEADER = /^((?:[\w@.-]+\/)*[\w@.-]+\.(?:test|spec)\.[cm]?[jt]sx?):$/;
const BUN_RESULT = /^\((pass|fail|skip|todo)\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/;
const JEST_HEADING = /^\s*●\s+(.+)$/;
const COMMAND_LINE = /^\$ /;

const TYPE_ERROR = /\berror TS\d+:/;
const EXCEPTION = /^(?:Uncaught )?(?:[A-Z]\w*)?(?:Error|Exception)(?::|\s*$)|^Traceback \(most recent call last\)|^panic:|^thread '.*' panicked/;
const ERROR = /^##\[error\]|^::error|^\s*error(?:\[\w+\])?:|^ERROR\b|^FATAL\b|^fatal:|^npm ERR!|^FAIL\s|^\s*✗\s|^\s*×\s/;

/** Lines that continue an error block: stack frames, carets, code frames, expected/received. */
const CONTINUATION = /^\s+at\s|^\s+File "|^\s*\^|^\s*\d+\s*\|\s|^\s*(?:Expected|Received|Actual|expected|received)\b|^\s{4,}\S|^\s*-\s|^\s*\+\s|^\s*at\s/;

const PATH = /(?:^|[\s("'`])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|sh))(?=[:()\s'"`]|$)/;

function normalize(text: string): string[] {
  return text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map(l => l.replace(TIMESTAMP, '').trimEnd());
}

function firstPath(lines: string[]): string | undefined {
  for (const l of lines) {
    const m = PATH.exec(l);
    if (m) return m[1];
  }
  return undefined;
}

function classify(line: string): EvidenceErrorClass | null {
  if (USELESS.test(line)) return null;
  if (TYPE_ERROR.test(line)) return 'type_error';
  if (EXCEPTION.test(line.trim())) return 'exception';
  if (ERROR.test(line)) return 'error';
  return null;
}

function trimBlank(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && !lines[s].trim()) s++;
  while (e > s && !lines[e - 1].trim()) e--;
  return lines.slice(s, e);
}

/** Collapse runs of blank lines and keep the last `max` lines. */
function tidy(lines: string[], max = MAX_BLOCK_LINES): string[] {
  const out: string[] = [];
  for (const l of trimBlank(lines)) {
    if (USELESS.test(l)) continue;
    if (!l.trim() && out.length > 0 && !out[out.length - 1].trim()) continue;
    out.push(l);
  }
  return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * Chunk one evidence object's text. Order is priority order, so the cap drops
 * the least specific signal: digest, summary, failing tests, error blocks, tail.
 */
export function chunkEvidenceLog(input: EvidenceChunkerInput): EvidenceChunk[] {
  const max = Math.max(0, input.maxChunks ?? DEFAULT_MAX_EVIDENCE_CHUNKS);
  const redact = createSecretRedactor(input.secretValues ?? []);
  const lines = input.text ? normalize(input.text) : [];

  const candidates: EvidenceChunk[] = [];
  if (input.digest?.trim()) candidates.push({ content: input.digest.trim(), errorClass: 'ci_digest' });
  if (input.summary?.trim()) candidates.push({ content: input.summary.trim(), errorClass: 'summary' });

  // ── Pass 1: failing tests, bounded by file headers and neighbouring results.
  const consumed = new Uint8Array(lines.length);
  let currentFile: string | undefined;
  let blockStart = 0;
  const testChunks: EvidenceChunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = FILE_HEADER.exec(line.trim());
    if (header) {
      currentFile = header[1];
      blockStart = i + 1;
      continue;
    }
    if (COMMAND_LINE.test(line)) {
      currentFile = undefined;
      blockStart = i + 1;
      continue;
    }
    const result = BUN_RESULT.exec(line.trim());
    if (result) {
      if (result[1] === 'fail') {
        const body = tidy(lines.slice(blockStart, i));
        const block = [...body, line.trim()];
        testChunks.push({
          content: block.join('\n'),
          errorClass: 'test_failure',
          testName: result[2].trim(),
          file: currentFile ?? firstPath(body),
        });
        for (let k = blockStart; k <= i; k++) consumed[k] = 1;
      }
      blockStart = i + 1;
      continue;
    }
    const jest = JEST_HEADING.exec(line);
    if (jest) {
      // A jest failure: the heading, then everything up to the next heading or result.
      let end = i + 1;
      while (end < lines.length && !JEST_HEADING.test(lines[end]) && !FILE_HEADER.test(lines[end].trim()) && !/^(?:PASS|FAIL)\s/.test(lines[end]) && end - i <= MAX_BLOCK_LINES) end++;
      const body = tidy(lines.slice(i + 1, end));
      testChunks.push({
        content: [line.trim(), ...body].join('\n'),
        errorClass: 'test_failure',
        testName: jest[1].trim(),
        file: currentFile ?? firstPath(body),
      });
      for (let k = i; k < end; k++) consumed[k] = 1;
      i = end - 1;
      blockStart = end;
    }
  }
  candidates.push(...testChunks);

  // ── Pass 2: error blocks outside the failing tests.
  for (let i = 0; i < lines.length; i++) {
    if (consumed[i]) continue;
    const cls = classify(lines[i]);
    if (!cls) continue;
    const block = [lines[i].trim()];
    let j = i + 1;
    while (j < lines.length && !consumed[j] && block.length <= MAX_CONTINUATION_LINES) {
      const next = lines[j];
      const sameClass = classify(next) === cls && cls === 'type_error';
      if (!sameClass && !CONTINUATION.test(next)) break;
      block.push(next);
      j++;
    }
    candidates.push({ content: tidy(block).join('\n'), errorClass: cls, file: firstPath(block) });
    i = j - 1;
  }

  // ── Pass 3: a failing command's tail.
  if (input.kind === 'command_output') {
    const tail = tidy(lines.filter(l => l.trim()).slice(-COMMAND_TAIL_LINES), COMMAND_TAIL_LINES);
    if (tail.length > 0) candidates.push({ content: tail.join('\n'), errorClass: 'command_tail', file: firstPath(tail) });
  }

  // ── Redact, clip, dedupe, cap.
  const seen = new Set<string>();
  const out: EvidenceChunk[] = [];
  for (const c of candidates) {
    if (out.length >= max) break;
    // Redact before clipping: a clip first could cut a secret below the length
    // the patterns recognise and leave its first half.
    const content = redact(c.content).slice(0, MAX_EVIDENCE_CHUNK_CHARS).trim();
    if (!content) continue;
    const key = content.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const chunk: EvidenceChunk = { content, errorClass: c.errorClass };
    if (c.testName) chunk.testName = redact(c.testName);
    if (c.file) chunk.file = c.file;
    out.push(chunk);
  }
  return out;
}
