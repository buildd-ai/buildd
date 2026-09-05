/**
 * Reviewer patch assembly.
 *
 * The reviewer agent decides whether a PR merges. Until this module existed it
 * saw only a list of changed filenames (`buildReviewerContext` rendered the
 * GitHub *files* endpoint's names and counts), so any finding that requires
 * reading a changed line was unreachable by construction. This renders the
 * actual patch text, deterministically, for pre-injection into the reviewer
 * task description — the agent is never asked to shell out to `gh` for it.
 *
 * Format follows Qodo PR-Agent's published hunk format (`prompt_fragments.toml`):
 * a per-file header, `@@ ... @@ <enclosing symbol>` taken from git's own hunk
 * header, then `__new hunk__` and — only when lines were removed — `__old hunk__`.
 *
 * One deliberate deviation: PR-Agent numbers every line of the new hunk. Here
 * **only added lines carry a number**. The reviewer is instructed to cite
 * file+line, so making context lines uncitable turns "the finding must anchor to
 * a line this PR introduced" into a property of the evidence rather than a rule
 * the model has to be trusted to follow.
 *
 * That property lives in `citableLines`, not in the rendered text. The text is
 * for the model; the anchoring filter downstream must read `citableLines`,
 * because patch content is PR-authored and a context line can be made to look
 * exactly like a numbered added line.
 *
 * See `docs/design/reviewer-evidence-and-verification.md`.
 */

export type PatchOmissionReason = 'token-budget' | 'no-patch' | 'deleted' | 'parse-failed';

export interface ReviewerPatchFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Absent for binary files and for files GitHub considers too large. */
  patch?: string | null;
  previousFilename?: string | null;
}

export interface RenderedPatch {
  /** Markdown section, ready to inline in the reviewer task description. */
  text: string;
  /** Files whose patch text is present, in input order. */
  includedFiles: string[];
  /** Files present by name only. Absence here is not cleanliness. */
  omittedFiles: Array<{ filename: string; reason: PatchOmissionReason }>;
  /** Included files that lost their `__old hunk__` sections to the budget. */
  deletionsStripped: string[];
  /**
   * The authoritative citable anchors: filename → new-file line numbers of the
   * added lines actually present in `text`.
   *
   * Downstream filters must use this and must **not** re-parse `text`. The
   * number column is not textually decidable: context lines are rendered as
   * `<width spaces>  <content>`, `width` is per-file and never emitted, so a
   * context line whose content happens to begin with digits and a `+` is
   * byte-identical to a numbered added line — and that content is PR-authored.
   * Any file in this repo that documents a diff, this module's own tests
   * included, forges plausible anchors for free.
   */
  citableLines: Record<string, number[]>;
  /**
   * Files where the count of added lines parsed disagrees with GitHub's own
   * `additions` count, meaning the parser lost or invented lines. The patch is
   * still rendered — dropping it costs more evidence than the discrepancy —
   * but `citableLines` for that file may be incomplete.
   */
  countMismatches: string[];
  estimatedTokens: number;
  /** True when anything was dropped — a whole file or just its deletions. */
  truncated: boolean;
}

export interface RenderReviewerPatchOptions {
  tokenBudget?: number;
}

/**
 * Chosen to leave the reviewer's own reasoning room in a long-context window
 * while still admitting the great majority of task-sized PRs whole.
 */
export const REVIEWER_PATCH_TOKEN_BUDGET = 24_000;

const CHARS_PER_TOKEN = 4;

/** Deliberately an estimate: cheap, stable, and never under-counts by much. */
export function estimatePatchTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type PatchLineKind = 'added' | 'removed' | 'context';

interface PatchLine {
  kind: PatchLineKind;
  content: string;
  /** New-file line number. Only set for added lines. */
  newLine?: number;
}

interface Hunk {
  /** Trailing text of git's `@@` header — usually the enclosing symbol. */
  symbol: string;
  lines: PatchLine[];
  hasAdditions: boolean;
  hasDeletions: boolean;
}

/**
 * `[\s\S]` rather than `.` for the trailing symbol: git copies the enclosing
 * line into the hunk header verbatim and strips only *trailing* whitespace, so
 * a source line holding a bare CR (or U+2028/U+2029) — mixed line endings, a
 * Windows-authored fixture, `"a\rb"` written as a raw byte — puts a
 * LineTerminator mid-header. `.` excludes all four of those and `$` without
 * the `m` flag only matches end-of-input, so `(.*)$` failed such a header
 * outright, the header fell through to the context branch, the new-side
 * counter never reset, and every following added line was numbered against the
 * *previous* hunk's origin. Wrong numbers are worse than no numbers here:
 * they are indistinguishable from right ones downstream.
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@([\s\S]*)$/;

interface ParsedPatch {
  hunks: Hunk[];
  /** True when a hunk header did not parse — line numbers are unknowable. */
  failed: boolean;
}

function parseHunks(patch: string): ParsedPatch {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let newLine = 1;

  const raws = patch.split('\n');
  // A trailing newline yields a final '' element, which is not a context line.
  if (raws.length > 0 && raws[raws.length - 1] === '') raws.pop();

  for (const raw of raws) {
    // Every body line carries a ' ', '+', '-' or '\' marker, so a line
    // starting with '@@' is a header. If it does not parse we cannot know
    // where the new side resumes, and guessing would emit confident wrong
    // anchors — fail the whole file instead.
    if (raw.startsWith('@@')) {
      const header = HUNK_HEADER.exec(raw);
      if (!header) return { hunks: [], failed: true };
      current = { symbol: header[2].trim(), lines: [], hasAdditions: false, hasDeletions: false };
      hunks.push(current);
      // A `+0,0` hunk has no added lines, so this only guards against citing
      // line 0 — an anchor to a line that cannot exist.
      newLine = Math.max(1, Number(header[1]));
      continue;
    }
    // Pre-hunk metadata (`diff --git`, `index`, `--- a/…`, `+++ b/…`) when the
    // caller passes raw `git diff` output rather than the API's `patch` field.
    if (!current) continue;
    // `\ No newline at end of file` is diff metadata, not a reviewable line.
    if (raw.startsWith('\\')) continue;

    // The file's own CRLF endings survive the '\n' split; a trailing CR is
    // noise in the prompt and breaks exact content matching downstream.
    const body = raw.replace(/\r$/, '');

    if (body.startsWith('+')) {
      current.lines.push({ kind: 'added', content: body.slice(1), newLine });
      current.hasAdditions = true;
      newLine++;
    } else if (body.startsWith('-')) {
      current.lines.push({ kind: 'removed', content: body.slice(1) });
      current.hasDeletions = true;
    } else {
      current.lines.push({ kind: 'context', content: body.startsWith(' ') ? body.slice(1) : body });
      newLine++;
    }
  }

  return { hunks, failed: false };
}

function addedLineNumbers(hunks: Hunk[]): number[] {
  const out: number[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added' && line.newLine != null) out.push(line.newLine);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fileHeader(file: ReviewerPatchFile): string {
  const renamed = file.previousFilename ? ` (renamed from '${file.previousFilename}')` : '';
  return `## File: '${file.filename}'${renamed}`;
}

function hunkHeader(hunk: Hunk): string {
  // Ranges become `...`: the inline numbers are the citable coordinates, and a
  // second set of numbers in the header only invites the model to cite those.
  return hunk.symbol ? `@@ ... @@ ${hunk.symbol}` : '@@ ... @@';
}

function newHunkSection(hunk: Hunk, width: number): string[] {
  const pad = ' '.repeat(width);
  const out = ['__new hunk__'];
  for (const line of hunk.lines) {
    if (line.kind === 'removed') continue;
    out.push(
      line.kind === 'added'
        ? `${String(line.newLine).padStart(width)} +${line.content}`
        : `${pad}  ${line.content}`,
    );
  }
  return out;
}

function oldHunkSection(hunk: Hunk): string[] {
  const out = ['__old hunk__'];
  for (const line of hunk.lines) {
    if (line.kind === 'added') continue;
    out.push(line.kind === 'removed' ? `-${line.content}` : ` ${line.content}`);
  }
  return out;
}

function lineNumberWidth(hunks: Hunk[]): number {
  let max = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added' && line.newLine != null && line.newLine > max) max = line.newLine;
    }
  }
  return Math.max(1, String(max).length);
}

/**
 * `withDeletions: false` is the budget-constrained form: `__old hunk__` is
 * dropped, and hunks that only removed lines go with it — stripped of their
 * `-` lines such a hunk holds no citable line, so its context costs budget and
 * buys nothing.
 */
function renderFileBlock(
  file: ReviewerPatchFile,
  hunks: Hunk[],
  withDeletions: boolean,
): string | null {
  const width = lineNumberWidth(hunks);
  const rendered = hunks
    .filter((h) => withDeletions || h.hasAdditions)
    .map((hunk) => {
      const parts = [hunkHeader(hunk), ...newHunkSection(hunk, width)];
      if (withDeletions && hunk.hasDeletions) parts.push(...oldHunkSection(hunk));
      return parts.join('\n');
    });

  if (rendered.length === 0) return null;

  // Without this note the additions-only form is byte-identical to a complete
  // diff of a file that only added lines — the reviewer would read a partial
  // rendering as whole. Every other omission in this module warns in-text; a
  // flag on the return object that the model never sees does not count.
  const note =
    !withDeletions && hunks.some((h) => h.hasDeletions)
      ? '\n(deletions omitted for space: removed lines and deletion-only hunks are not shown for this file)'
      : '';

  return [`${fileHeader(file)}${note}`, '', rendered.join('\n\n')].join('\n');
}

/**
 * The omission manifest is never dropped to fit the budget — a reviewer that
 * cannot see a file must at least know the file exists. It is capped instead,
 * so a pathological PR cannot turn the manifest itself into the overflow.
 */
const NAME_LIST_CAP = 50;

function nameList(
  files: ReviewerPatchFile[],
  render: (f: ReviewerPatchFile) => string = (f) => `- ${f.filename}`,
): string {
  const lines = files.slice(0, NAME_LIST_CAP).map(render);
  if (files.length > NAME_LIST_CAP) {
    lines.push(`- … and ${files.length - NAME_LIST_CAP} more`);
  }
  return lines.join('\n');
}

function overflowSection(files: ReviewerPatchFile[]): string {
  if (files.length === 0) return '';
  const lines = nameList(files, (f) => `- ${f.filename} (+${f.additions}/-${f.deletions})`);
  return [
    '## Not Reviewed — Token Budget',
    '',
    'These files changed but their patch text did not fit the budget. They are',
    'not reviewed. Do not treat their absence as evidence that they are clean —',
    'if a verdict depends on them, escalate instead of approving.',
    '',
    lines,
  ].join('\n');
}

function deletedSection(files: ReviewerPatchFile[]): string {
  if (files.length === 0) return '';
  return ['## Deleted Files', '', nameList(files)].join('\n');
}

function noPatchSection(files: ReviewerPatchFile[]): string {
  if (files.length === 0) return '';
  return [
    '## No Patch Available',
    '',
    'GitHub returned no patch text for these files (binary, or too large to diff).',
    'They are not reviewed.',
    '',
    nameList(files),
  ].join('\n');
}

/**
 * Separate from "No Patch Available" on purpose. Blaming GitHub for a patch it
 * did in fact return sends the reader looking in the wrong place, and hides
 * the parser bug that is the actual cause.
 */
function parseFailedSection(files: ReviewerPatchFile[]): string {
  if (files.length === 0) return '';
  return [
    '## Patch Not Parsed',
    '',
    'GitHub returned patch text for these files but it could not be parsed into',
    'hunks, so no line numbers could be established. They are not reviewed.',
    '',
    nameList(files),
  ].join('\n');
}

function warningSection(filenames: string[]): string {
  if (filenames.length === 0) return '';
  return [
    '## Rendering Warnings',
    '',
    "The added-line count in this rendering disagrees with GitHub's own count",
    'for these files. The patch below is shown in full, but a line you cannot',
    'find in it may still have changed — do not conclude from its absence.',
    '',
    filenames.map((f) => `- ${f}`).join('\n'),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Candidate {
  file: ReviewerPatchFile;
  /** Additions-only form. Null when the file removed lines and added none. */
  newOnly: string | null;
  full: string;
  hasDeletions: boolean;
  addedLines: number[];
}

export function renderReviewerPatch(
  files: ReviewerPatchFile[],
  options: RenderReviewerPatchOptions = {},
): RenderedPatch {
  const tokenBudget = options.tokenBudget ?? REVIEWER_PATCH_TOKEN_BUDGET;

  if (files.length === 0) {
    return {
      text: '',
      includedFiles: [],
      omittedFiles: [],
      deletionsStripped: [],
      citableLines: {},
      countMismatches: [],
      estimatedTokens: 0,
      truncated: false,
    };
  }

  const deleted: ReviewerPatchFile[] = [];
  const noPatch: ReviewerPatchFile[] = [];
  const parseFailed: ReviewerPatchFile[] = [];
  const countMismatches: string[] = [];
  const candidates: Candidate[] = [];

  for (const file of files) {
    if (file.status === 'removed') {
      deleted.push(file);
      continue;
    }
    if (!file.patch) {
      noPatch.push(file);
      continue;
    }
    const { hunks, failed } = parseHunks(file.patch);
    const full = failed ? null : renderFileBlock(file, hunks, true);
    if (!full) {
      // Patch text existed, so this is our failure, not a missing payload.
      parseFailed.push(file);
      continue;
    }
    const addedLines = addedLineNumbers(hunks);
    // Cheap invariant against parser drift: GitHub's count is authoritative,
    // and a mismatch means we lost or invented lines. It does not disqualify
    // the patch — the discrepancy is smaller than the evidence — but it is
    // said out loud rather than left for the reviewer to trip over.
    if (typeof file.additions === 'number' && addedLines.length !== file.additions) {
      countMismatches.push(file.filename);
    }
    candidates.push({
      file,
      newOnly: renderFileBlock(file, hunks, false),
      full,
      hasDeletions: hunks.some((h) => h.hasDeletions),
      addedLines,
    });
  }

  const totalAdded = files.reduce((s, f) => s + (f.additions || 0), 0);
  const totalDeleted = files.reduce((s, f) => s + (f.deletions || 0), 0);
  const summary = `## PR Diff (+${totalAdded}/-${totalDeleted} across ${files.length} file${
    files.length === 1 ? '' : 's'
  })`;

  // Reserve the worst case for every non-patch section — the overflow list is
  // sized as if no candidate fits. Actual output can only be smaller, so the
  // budget below is a real ceiling for the whole rendering, not just for the
  // patch text. The one exception is a budget smaller than the manifest
  // itself: the manifest wins, because dropping it would let the reviewer read
  // absence as cleanliness. `estimatedTokens` reports what was actually built.
  const reserve =
    estimatePatchTokens(summary) +
    estimatePatchTokens(overflowSection(candidates.map((c) => c.file))) +
    estimatePatchTokens(deletedSection(deleted)) +
    estimatePatchTokens(noPatchSection(noPatch)) +
    estimatePatchTokens(parseFailedSection(parseFailed)) +
    estimatePatchTokens(warningSection(countMismatches));
  let remaining = Math.max(0, tokenBudget - reserve);

  // Pass 1 — additions first, across every file, before any file's deletions.
  const selected: Array<{ candidate: Candidate; body: string; withDeletions: boolean }> = [];
  const overflow: ReviewerPatchFile[] = [];
  for (const candidate of candidates) {
    const body = candidate.newOnly ?? candidate.full;
    const withDeletions = candidate.newOnly === null;
    const cost = estimatePatchTokens(body);
    if (cost <= remaining) {
      remaining -= cost;
      selected.push({ candidate, body, withDeletions });
    } else {
      overflow.push(candidate.file);
    }
  }

  // Pass 2 — spend what is left restoring deletions, in file order.
  for (const entry of selected) {
    if (entry.withDeletions || !entry.candidate.hasDeletions) continue;
    const delta = estimatePatchTokens(entry.candidate.full) - estimatePatchTokens(entry.body);
    if (delta <= remaining) {
      remaining -= delta;
      entry.body = entry.candidate.full;
      entry.withDeletions = true;
    }
  }

  const deletionsStripped = selected
    .filter((e) => !e.withDeletions && e.candidate.hasDeletions)
    .map((e) => e.candidate.file.filename);

  const includedMismatches = countMismatches.filter((name) =>
    selected.some((e) => e.candidate.file.filename === name),
  );

  const text = [
    summary,
    warningSection(includedMismatches),
    ...selected.map((e) => e.body),
    overflowSection(overflow),
    deletedSection(deleted),
    noPatchSection(noPatch),
    parseFailedSection(parseFailed),
  ]
    .filter(Boolean)
    .join('\n\n');

  const citableLines: Record<string, number[]> = {};
  for (const entry of selected) {
    citableLines[entry.candidate.file.filename] = entry.candidate.addedLines;
  }

  return {
    text,
    includedFiles: selected.map((e) => e.candidate.file.filename),
    omittedFiles: [
      ...overflow.map((f) => ({ filename: f.filename, reason: 'token-budget' as const })),
      ...deleted.map((f) => ({ filename: f.filename, reason: 'deleted' as const })),
      ...noPatch.map((f) => ({ filename: f.filename, reason: 'no-patch' as const })),
      ...parseFailed.map((f) => ({ filename: f.filename, reason: 'parse-failed' as const })),
    ],
    deletionsStripped,
    citableLines,
    countMismatches: includedMismatches,
    estimatedTokens: estimatePatchTokens(text),
    truncated: overflow.length > 0 || deletionsStripped.length > 0 || parseFailed.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface GithubPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string | null;
  previous_filename?: string | null;
}

/**
 * GitHub's payload is snake_case. Normalising at every entry point rather than
 * accepting both spellings internally keeps `previous_filename` from being
 * silently dropped by a caller that hands the raw payload straight through.
 */
export function normalizeGithubPrFiles(raw: GithubPrFile[]): ReviewerPatchFile[] {
  return raw.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    patch: f.patch ?? null,
    previousFilename: f.previous_filename ?? null,
  }));
}

/**
 * Fetches the PR's files (patch text included) and renders them. Returns null
 * on any GitHub failure — the caller keeps its existing filename-list section
 * rather than shipping a reviewer task with a half-built evidence base.
 *
 * The import is lazy for the same reason `buildReviewerContext` does it:
 * `@/lib/github` pulls in credential plumbing that the pure renderer's tests
 * must not require.
 */
export async function fetchReviewerPatch(params: {
  installationId: number | string;
  repoFullName: string;
  prNumber: number;
  tokenBudget?: number;
}): Promise<RenderedPatch | null> {
  try {
    const { githubApi } = await import('@/lib/github');
    const files: GithubPrFile[] = await githubApi(
      params.installationId as never,
      `/repos/${params.repoFullName}/pulls/${params.prNumber}/files?per_page=300`,
    );
    if (!Array.isArray(files)) return null;

    return renderReviewerPatch(normalizeGithubPrFiles(files), {
      tokenBudget: params.tokenBudget,
    });
  } catch (err) {
    console.warn(`[reviewer-patch] Failed to fetch patch for PR #${params.prNumber}:`, err);
    return null;
  }
}
