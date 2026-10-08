/**
 * Reading evidence objects back (docs/specs/byo-evidence-storage.md, "Read paths").
 *
 * Every read is proxied through the server: the object is streamed from the
 * backend, gunzipped, redacted line by line, then cut by tail / grep / range to
 * at most EVIDENCE_READ_CAP_BYTES of text. Callers get text, a `truncated`
 * flag and a cursor, never a presigned URL.
 *
 * Bounds, so a large or hostile object cannot pin a request:
 * - a raw line is read up to RAW_LINE_CHARS (a line that never ends is not
 *   buffered past that), redacted, then clipped to MAX_LINE_CHARS;
 * - at most MAX_SCAN_BYTES of decompressed text is scanned (gzip bombs);
 * - a scan stops after SCAN_TIME_BUDGET_MS, checked before every line when
 *   grep is set;
 * - grep patterns are capped at MAX_GREP_PATTERN_LENGTH; nested quantifiers,
 *   more than one unbounded quantifier and large choice products are refused
 *   (backtrackingProblem), and the regex runs over the first GREP_WINDOW_CHARS
 *   of one line at a time.
 *
 * Server-only: opens backend clients.
 */
import { Readable } from 'stream';
import { createGunzip } from 'zlib';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '@buildd/core/config';
import { db } from '@buildd/core/db';
import { evidenceBackends, evidenceObjects } from '@buildd/core/db/schema';
import { createSecretRedactor } from '@buildd/core/redaction';
import type { EvidenceKind, EvidenceObjectSummary, EvidenceReadResult } from '@buildd/shared';
import { and, desc, eq, or } from 'drizzle-orm';
import { getEvidenceS3Client } from './evidence-backend';
import { getDefaultStorageClient } from './storage';

export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['command_output', 'test_report', 'ci_job_log', 'transcript', 'pr_diff'];
export const EVIDENCE_READ_CAP_BYTES = 64 * 1024;
export const MAX_GREP_PATTERN_LENGTH = 200;
export const MAX_LINE_CHARS = 4096;
/** Raw line length read before redaction; redaction runs on this, the clip to MAX_LINE_CHARS after it. */
const RAW_LINE_CHARS = 16 * 1024;
/** grep is evaluated over this much of each (redacted, clipped) line. */
export const GREP_WINDOW_CHARS = 1024;
export const MAX_TAIL_LINES = 10_000;
export const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const SCAN_TIME_BUDGET_MS = 5_000;

export interface EvidenceReadOptions {
  /** Keep only the last N (surviving) lines. */
  tail?: number;
  grep?: RegExp;
  /** 1-based first line to consider. */
  start: number;
  /** 1-based last line to consider (inclusive). */
  end?: number;
}

type Parsed<T> = { ok: true } & T | { ok: false; error: string };

const positiveInt = (s: string): number | null => (/^\d{1,9}$/.test(s) && Number(s) > 0 ? Number(s) : null);

/** At most this many unbounded quantifiers (`*`, `+`, `{n,}`) per grep pattern. */
const MAX_UNBOUNDED_QUANTIFIERS = 1;
/** Product of the bounded choices (`?`, `{n,m}`, alternation groups) allowed with / without an unbounded quantifier. */
const MAX_BOUNDED_CHOICES_WITH_UNBOUNDED = 8;
const MAX_BOUNDED_CHOICES = 256;
const MAX_REPEAT_COUNT = 1000;

/**
 * How much backtracking a pattern can do, read off its syntax. JS regexes
 * backtrack, and RegExp#test cannot be preempted, so the bound has to hold
 * before the pattern runs:
 * - two unbounded quantifiers backtrack polynomially (`.*.*x` is cubic, and
 *   each extra `.*` adds a power), so at most one is allowed;
 * - bounded choices multiply (`a?a?a?…` is 2^k), so their product is capped,
 *   tighter when an unbounded quantifier is also present.
 * With one unbounded quantifier over a GREP_WINDOW_CHARS window, the worst
 * case per line is quadratic in the window times the choice product.
 */
function backtrackingProblem(pattern: string): string | null {
  let unbounded = 0;
  let choices = 1;
  // Per open group: its alternatives, and whether its body holds any
  // quantifier or alternation (then the group may not be quantified at all).
  const groups: Array<{ alts: number; complex: boolean; quantified: boolean }> = [];
  const p = pattern;
  let i = 0;
  const skipLazy = () => { if (p[i] === '?') i++; };
  const markComplex = (quantified = true) => {
    const top = groups[groups.length - 1];
    if (top) { top.complex = true; if (quantified) top.quantified = true; }
  };
  const quantifierAt = (j: number) => p[j] === '*' || p[j] === '+' || p[j] === '?' || (p[j] === '{' && /^\{\d+(,\d*)?\}/.test(p.slice(j)));
  while (i < p.length) {
    const c = p[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      i++;
      if (p[i] === '^') i++;
      if (p[i] === ']') i++;
      while (i < p.length && p[i] !== ']') i += p[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(') {
      groups.push({ alts: 1, complex: false, quantified: false });
      i++;
      if (p[i] === '?') {
        i++;
        if (p[i] === '<' && p[i + 1] !== '=' && p[i + 1] !== '!') {
          while (i < p.length && p[i] !== '>') i++;
          i++;
        } else if (p[i] === '<') i += 2;
        else i++; // ':', '=', '!'
      }
      continue;
    }
    if (c === '|') {
      if (groups.length) { groups[groups.length - 1].alts++; markComplex(false); }
      i++;
      continue;
    }
    if (c === ')') {
      const g = groups.pop() ?? { alts: 1, complex: false, quantified: false };
      i++;
      // A plain alternation made optional, "fail(ed|ure)?", is alts + 1 paths.
      const quantifierFree = !g.complex || (g.alts > 1 && !g.quantified);
      if (quantifierFree && g.alts > 1 && p[i] === '?' && !quantifierAt(i + 1)) {
        choices *= g.alts + 1;
        i++;
        markComplex();
        continue;
      }
      choices *= g.alts;
      // (?:a?){10} is 2^10 paths, not 10: a repeated group multiplies its
      // body's choices by the repeat count. Log grep never needs one.
      if (g.complex && quantifierAt(i)) {
        return 'grep pattern repeats a group that already has a quantifier or alternation inside (e.g. "(?:a?){5}" or "(a|b)+"); write it out without the repeat';
      }
      if (g.complex) markComplex(g.quantified);
      continue;
    }
    if (c === '*' || c === '+') { unbounded++; markComplex(); i++; skipLazy(); continue; }
    if (c === '?') { choices *= 2; markComplex(); i++; skipLazy(); continue; }
    if (c === '{') {
      const m = p.slice(i).match(/^\{(\d+)(,(\d*))?\}/);
      if (m) {
        const min = Number(m[1]);
        markComplex();
        if (m[2] && m[3] === '') unbounded++;
        else {
          const max = m[3] ? Number(m[3]) : min;
          if (max > MAX_REPEAT_COUNT) return `grep repeat counts are limited to ${MAX_REPEAT_COUNT}`;
          choices *= Math.max(1, max - min + 1);
        }
        i += m[0].length;
        skipLazy();
        continue;
      }
    }
    i++;
  }
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) {
    return 'grep pattern may use only one unbounded quantifier (*, + or {n,}); e.g. "error.*timeout" is fine, ".*error.*timeout" is not';
  }
  const limit = unbounded ? MAX_BOUNDED_CHOICES_WITH_UNBOUNDED : MAX_BOUNDED_CHOICES;
  if (choices > limit) return 'grep pattern has too many optional parts (?, {n,m}, alternations); simplify it';
  return null;
}

/**
 * A regex the scan can run safely: bounded length, no nested quantifier, at
 * most one unbounded quantifier and a bounded number of choices.
 * Case-insensitive, since "fail" should find "FAIL" in a test log.
 */
export function compileGrepPattern(pattern: string): Parsed<{ re: RegExp }> {
  if (!pattern) return { ok: false, error: 'grep pattern is empty' };
  if (pattern.length > MAX_GREP_PATTERN_LENGTH) {
    return { ok: false, error: `grep pattern is longer than ${MAX_GREP_PATTERN_LENGTH} characters` };
  }
  const problem = backtrackingProblem(pattern);
  if (problem) return { ok: false, error: problem };
  // A quantified group whose body itself holds a quantifier or an alternation:
  // (a+)+, (a*)*, (\w+\s?)+, (a|aa)+. These backtrack exponentially on a
  // near-miss; nothing a log grep needs looks like this.
  const noClasses = pattern.replace(/\\./g, 'e').replace(/\[[^\]]*\]/g, 'c');
  if (/\([^()]*([+*}]|\|)[^()]*\)\s*([+*]|\{\d)/.test(noClasses)) {
    return { ok: false, error: 'grep pattern has a nested quantifier; simplify it (e.g. "a+" instead of "(a+)+")' };
  }
  if (/\\(\d|k<)/.test(pattern)) return { ok: false, error: 'grep pattern may not use backreferences' };
  try {
    return { ok: true, re: new RegExp(pattern, 'i') };
  } catch (err) {
    return { ok: false, error: `grep is not a valid regular expression: ${err instanceof Error ? err.message : 'invalid'}` };
  }
}

/** `tail`, `grep`, `range` (`a-b` | `a-` | `a`, 1-based lines) and `cursor` (a line to resume from). */
export function parseEvidenceReadParams(sp: URLSearchParams): Parsed<{ options: EvidenceReadOptions }> {
  const options: EvidenceReadOptions = { start: 1 };

  const tail = sp.get('tail');
  if (tail !== null && tail !== '') {
    const n = positiveInt(tail);
    if (!n || n > MAX_TAIL_LINES) return { ok: false, error: `tail must be an integer from 1 to ${MAX_TAIL_LINES}` };
    options.tail = n;
  }

  const range = sp.get('range');
  if (range !== null && range !== '') {
    const m = range.match(/^(\d+)(?:-(\d*))?$/);
    const start = m ? positiveInt(m[1]) : null;
    const end = m && m[2] ? positiveInt(m[2]) : undefined;
    if (!m || !start || end === null || (end !== undefined && end < start)) {
      return { ok: false, error: 'range must be START-END, START- or START (1-based line numbers, START <= END)' };
    }
    options.start = start;
    if (m[2] === undefined) options.end = start;
    else if (end !== undefined) options.end = end;
  }

  const cursor = sp.get('cursor');
  if (cursor !== null && cursor !== '') {
    const n = positiveInt(cursor);
    if (!n) return { ok: false, error: 'cursor must be a line number returned by a previous read' };
    options.start = Math.max(options.start, n);
    if (options.end !== undefined && options.end < options.start) return { ok: false, error: 'cursor is past the end of range' };
  }

  const grep = sp.get('grep');
  if (grep !== null && grep !== '') {
    const c = compileGrepPattern(grep);
    if (!c.ok) return c;
    options.grep = c.re;
  }

  return { ok: true, options };
}

// ── Body decoding ──────────────────────────────────────────────────────────

/** Gunzip when the body starts with the gzip magic bytes; plain text passes through. */
export async function* decodeEvidenceBody(src: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const it = src[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  const head = first.value;
  const rest = async function* () {
    yield head;
    while (true) {
      const n = await it.next();
      if (n.done) return;
      yield n.value;
    }
  };
  if (!(head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b)) {
    yield* rest();
    return;
  }
  const input = Readable.from(rest());
  const gunzip = createGunzip();
  input.on('error', err => gunzip.destroy(err));
  input.pipe(gunzip);
  try {
    for await (const chunk of gunzip) yield chunk as Buffer;
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

// ── Line scan ──────────────────────────────────────────────────────────────

/** Raw lines, each clipped to RAW_LINE_CHARS; a line with no end is never buffered past that. */
async function* splitLines(src: AsyncIterable<Uint8Array>, onBytes: (n: number) => boolean): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let skipping = false; // inside a clipped line, dropping until its newline
  for await (const chunk of src) {
    if (!onBytes(chunk.length)) return;
    let text = decoder.decode(chunk, { stream: true });
    while (text.length > 0) {
      const nl = text.indexOf('\n');
      if (nl < 0) {
        if (!skipping) {
          pending += text;
          if (pending.length > RAW_LINE_CHARS) {
            yield pending.slice(0, RAW_LINE_CHARS);
            pending = '';
            skipping = true;
          }
        }
        break;
      }
      if (!skipping) yield (pending + text.slice(0, nl)).slice(0, RAW_LINE_CHARS);
      pending = '';
      skipping = false;
      text = text.slice(nl + 1);
    }
  }
  const tailText = decoder.decode();
  if (!skipping && (pending || tailText)) yield (pending + tailText).slice(0, RAW_LINE_CHARS);
}

const serverRedactor = createSecretRedactor([]);

export interface ReadDeps {
  redact?: (line: string) => string;
  capBytes?: number;
  now?: () => number;
}

/**
 * Scan an object body line by line and return at most `capBytes` of text.
 * The body is redacted before grep sees it, so a pattern can't probe for a
 * secret the output would have hidden.
 */
export async function readEvidenceText(
  source: AsyncIterable<Uint8Array>,
  options: EvidenceReadOptions,
  deps: ReadDeps = {},
): Promise<EvidenceReadResult> {
  const redact = deps.redact ?? serverRedactor;
  const cap = deps.capBytes ?? EVIDENCE_READ_CAP_BYTES;
  const now = deps.now ?? Date.now;
  const started = now();
  const numbered = !!options.grep;

  let scanned = 0;
  let scanLimited = false;
  const countBytes = (n: number) => {
    scanned += n;
    if (scanned > MAX_SCAN_BYTES) { scanLimited = true; return false; }
    return true;
  };

  // Forward mode output
  const out: string[] = [];
  let outBytes = 0;
  // Tail mode: a ring with a moving head (Array#shift is O(n)).
  const ring: Array<{ n: number; s: string; b: number }> = [];
  let head = 0;

  let truncated = false;
  let cursor: string | null = null;
  let fromLine: number | null = null;
  let toLine: number | null = null;
  let lineNo = 0;

  for await (const raw of splitLines(source, countBytes)) {
    lineNo++;
    // With grep, every line: one regex evaluation is the unit of work that
    // can't be preempted, so the budget is checked between each of them.
    if ((options.grep || lineNo % 512 === 0) && now() - started > SCAN_TIME_BUDGET_MS) {
      truncated = true;
      cursor = String(lineNo);
      break;
    }
    if (lineNo < options.start) continue;
    if (options.end !== undefined && lineNo > options.end) break;

    // Redact, then clip: a clip first could cut a secret below the length the
    // patterns recognise and show its first half.
    const line = redact(raw).slice(0, MAX_LINE_CHARS);
    if (options.grep && !options.grep.test(line.slice(0, GREP_WINDOW_CHARS))) continue;
    const s = numbered ? `${lineNo}:${line}` : line;
    const b = Buffer.byteLength(s) + 1;

    if (options.tail) {
      ring.push({ n: lineNo, s, b });
      outBytes += b;
      while (ring.length - head > options.tail) outBytes -= ring[head++].b;
      while (outBytes - 1 > cap && ring.length - head > 0) {
        outBytes -= ring[head++].b;
        truncated = true;
      }
      if (head > 4096) { ring.splice(0, head); head = 0; }
      continue;
    }

    if (outBytes + b - 1 > cap) {
      truncated = true;
      cursor = String(lineNo);
      break;
    }
    out.push(s);
    outBytes += b;
    fromLine ??= lineNo;
    toLine = lineNo;
  }

  if (scanLimited && !truncated) {
    truncated = true;
    cursor = options.tail ? null : String(lineNo + 1);
  }

  let text: string;
  let lineCount: number;
  if (options.tail) {
    const kept = ring.slice(head);
    text = kept.map(k => k.s).join('\n');
    lineCount = kept.length;
    fromLine = kept[0]?.n ?? null;
    toLine = kept[kept.length - 1]?.n ?? null;
  } else {
    text = out.join('\n');
    lineCount = out.length;
  }

  return { text, truncated, cursor, fromLine, toLine, lineCount, scannedLines: lineNo, scanLimited };
}

// ── Opening an object ──────────────────────────────────────────────────────

export type EvidenceObjectRow = typeof evidenceObjects.$inferSelect;

/** A read that cannot be served; the route maps `status` onto the response. */
export class EvidenceReadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EvidenceReadError';
  }
}

/** Test seam: resolve the client and bucket an object lives in. */
export interface OpenDeps {
  client?: Pick<S3Client, 'send'>;
  bucket?: string;
}

/**
 * The client and bucket of the backend the row was written to (its
 * `backend_id`), not whatever the workspace resolves to now: a later backend
 * change must not send a read or a HEAD to the wrong bucket.
 */
export async function evidenceObjectLocation(row: Pick<EvidenceObjectRow, 'backendId'>):
  Promise<{ client: Pick<S3Client, 'send'>; bucket: string }> {
  if (!row.backendId) return { client: getDefaultStorageClient(), bucket: config.storageBucket };
  const backend = await db.query.evidenceBackends.findFirst({ where: eq(evidenceBackends.id, row.backendId) });
  if (!backend) throw new EvidenceReadError('the storage backend this object was written to no longer exists', 410);
  let client: Pick<S3Client, 'send'>;
  try {
    client = await getEvidenceS3Client(backend);
  } catch (err) {
    throw new EvidenceReadError(`the storage backend cannot be reached: ${err instanceof Error ? err.message : 'unknown error'}`.slice(0, 300), 502);
  }
  return { client, bucket: backend.provider === 'buildd_default' ? config.storageBucket : backend.bucket };
}

/**
 * The decoded body of one stored object. Only `stored` rows are opened: a
 * runner upload is `pending` until it is confirmed (evidence-confirm.ts).
 */
export async function openEvidenceObject(row: EvidenceObjectRow, deps: OpenDeps = {}): Promise<AsyncGenerator<Uint8Array>> {
  if (row.uploadState !== 'stored') {
    throw new EvidenceReadError(`this evidence object is not readable (upload state: ${row.uploadState})`, 409);
  }

  let client = deps.client;
  let bucket = deps.bucket;
  if (!client || !bucket) {
    ({ client, bucket } = await evidenceObjectLocation(row));
  }

  let body: unknown;
  try {
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: row.objectKey }));
    body = (got as { Body?: unknown }).Body;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) {
      throw new EvidenceReadError('this evidence object is missing from its bucket (expired or deleted)', 410);
    }
    throw new EvidenceReadError(`the storage backend refused the read: ${e?.name || 'error'}`, 502);
  }
  if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') {
    throw new EvidenceReadError('the storage backend returned no body for this object', 502);
  }
  return decodeEvidenceBody(body as AsyncIterable<Uint8Array>);
}

// ── Task lineage ───────────────────────────────────────────────────────────

/** The task an evidence list, read or download is scoped to, after the caller's access to its workspace was checked. */
export interface EvidenceTaskScope {
  id: string;
  workspaceId: string;
}

/** Objects written for the task and, for a root task, for its whole retry chain. */
export function taskEvidenceLineage(taskId: string) {
  return or(eq(evidenceObjects.taskId, taskId), eq(evidenceObjects.rootTaskId, taskId));
}

/** Checked again on the row itself: the query predicate is the scope, this is the proof. */
export function evidenceBelongsToTask(
  row: Pick<EvidenceObjectRow, 'workspaceId' | 'taskId' | 'rootTaskId'>,
  task: EvidenceTaskScope,
): boolean {
  return row.workspaceId === task.workspaceId && (row.taskId === task.id || row.rootTaskId === task.id);
}

/** A task's evidence objects, newest first. */
export async function listTaskEvidenceObjects(
  task: EvidenceTaskScope,
  opts: { kind?: EvidenceKind; limit?: number } = {},
): Promise<EvidenceObjectRow[]> {
  const rows = (await db.query.evidenceObjects.findMany({
    where: and(
      eq(evidenceObjects.workspaceId, task.workspaceId),
      taskEvidenceLineage(task.id),
      ...(opts.kind ? [eq(evidenceObjects.kind, opts.kind)] : []),
    ),
    orderBy: [desc(evidenceObjects.createdAt)],
    limit: opts.limit ?? 200,
  })) as EvidenceObjectRow[];
  return rows.filter(r => evidenceBelongsToTask(r, task));
}

/** One object of the task's lineage, or null when it is not the task's. */
export async function findTaskEvidenceObject(task: EvidenceTaskScope, evidenceId: string): Promise<EvidenceObjectRow | null> {
  const row = (await db.query.evidenceObjects.findFirst({
    where: and(
      eq(evidenceObjects.id, evidenceId),
      eq(evidenceObjects.workspaceId, task.workspaceId),
      taskEvidenceLineage(task.id),
    ),
  })) as EvidenceObjectRow | undefined;
  return row && row.id === evidenceId && evidenceBelongsToTask(row, task) ? row : null;
}

// ── Scout run ownership ───────────────────────────────────────────────────

/** The Scout run an evidence list or read is scoped to, after the caller's access to its workspace was checked. */
export interface EvidenceScoutRunScope {
  id: string;
  workspaceId: string;
}

/** Checked again on the row itself: the query predicate is the scope, this is the proof. */
export function evidenceBelongsToScoutRun(
  row: Pick<EvidenceObjectRow, 'workspaceId' | 'scoutRunId'>,
  run: EvidenceScoutRunScope,
): boolean {
  return row.workspaceId === run.workspaceId && row.scoutRunId === run.id;
}

/** A Scout run's evidence objects, newest first. */
export async function listScoutRunEvidenceObjects(
  run: EvidenceScoutRunScope,
  opts: { kind?: EvidenceKind; limit?: number } = {},
): Promise<EvidenceObjectRow[]> {
  const rows = (await db.query.evidenceObjects.findMany({
    where: and(
      eq(evidenceObjects.workspaceId, run.workspaceId),
      eq(evidenceObjects.scoutRunId, run.id),
      ...(opts.kind ? [eq(evidenceObjects.kind, opts.kind)] : []),
    ),
    orderBy: [desc(evidenceObjects.createdAt)],
    limit: opts.limit ?? 200,
  })) as EvidenceObjectRow[];
  return rows.filter(r => evidenceBelongsToScoutRun(r, run));
}

/** One object of the Scout run, or null when it is not the run's. */
export async function findScoutRunEvidenceObject(run: EvidenceScoutRunScope, evidenceId: string): Promise<EvidenceObjectRow | null> {
  const row = (await db.query.evidenceObjects.findFirst({
    where: and(
      eq(evidenceObjects.id, evidenceId),
      eq(evidenceObjects.workspaceId, run.workspaceId),
      eq(evidenceObjects.scoutRunId, run.id),
    ),
  })) as EvidenceObjectRow | undefined;
  return row && row.id === evidenceId && evidenceBelongsToScoutRun(row, run) ? row : null;
}

// ── Download (dashboard only) ──────────────────────────────────────────────

/**
 * A download link is minted per click and lives this long. Only the dashboard
 * download route mints one; no chat tool, MCP action or read route returns it.
 */
export const EVIDENCE_DOWNLOAD_EXPIRY_SECONDS = 5 * 60;

export interface EvidenceDownloadLink {
  url: string;
  expiresAt: string;
  filename: string;
}

export interface DownloadDeps extends OpenDeps {
  now?: () => number;
}

/** The name the browser saves: kind plus the key's last segment, reduced to safe characters. */
export function evidenceDownloadFilename(row: Pick<EvidenceObjectRow, 'objectKey' | 'kind' | 'id'>): string {
  const base = (row.objectKey.split('/').pop() ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return base && !/^\.+$/.test(base) ? `${row.kind}-${base}` : `${row.kind}-${row.id.slice(0, 8)}.gz`;
}

/**
 * A presigned GET for one stored object, on the backend the row was written to
 * (its `backend_id`), valid for EVIDENCE_DOWNLOAD_EXPIRY_SECONDS. The body is
 * the object as stored: redacted when it was written, usually gzipped.
 */
export async function generateEvidenceDownloadUrl(row: EvidenceObjectRow, deps: DownloadDeps = {}): Promise<EvidenceDownloadLink> {
  if (row.uploadState !== 'stored') {
    throw new EvidenceReadError(`this evidence object cannot be downloaded (upload state: ${row.uploadState})`, 409);
  }
  let client = deps.client;
  let bucket = deps.bucket;
  if (!client || !bucket) {
    ({ client, bucket } = await evidenceObjectLocation(row));
  }
  const filename = evidenceDownloadFilename(row);
  const issuedAt = (deps.now ?? Date.now)();
  let url: string;
  try {
    url = await getSignedUrl(client as S3Client, new GetObjectCommand({
      Bucket: bucket,
      Key: row.objectKey,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    }), { expiresIn: EVIDENCE_DOWNLOAD_EXPIRY_SECONDS });
  } catch (err) {
    throw new EvidenceReadError(`could not sign a download link: ${err instanceof Error ? err.message : 'unknown error'}`.slice(0, 300), 502);
  }
  return { url, filename, expiresAt: new Date(issuedAt + EVIDENCE_DOWNLOAD_EXPIRY_SECONDS * 1000).toISOString() };
}

// ── Wire shape and audit ───────────────────────────────────────────────────

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** What list responses carry: never the bucket, never a URL. */
export function toEvidenceObjectSummary(row: EvidenceObjectRow): EvidenceObjectSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    taskId: row.taskId ?? null,
    rootTaskId: row.rootTaskId ?? null,
    workerId: row.workerId ?? null,
    scoutRunId: row.scoutRunId ?? null,
    prNumber: row.prNumber ?? null,
    kind: row.kind,
    bytes: row.bytes,
    uploadState: row.uploadState,
    indexState: row.indexState,
    createdAt: iso(row.createdAt)!,
    expiresAt: iso(row.expiresAt),
  };
}

// The audit line lives in its own module so the inline list can use it
// without importing this file's S3 read path.
export { auditEvidenceRead, type EvidenceReadAudit } from './evidence-audit';
