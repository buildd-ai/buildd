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
 * See `docs/design/reviewer-evidence-and-verification.md`.
 */

export type PatchOmissionReason = 'token-budget' | 'no-patch' | 'deleted';

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

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let newLine = 0;

  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = { symbol: header[2].trim(), lines: [], hasAdditions: false, hasDeletions: false };
      hunks.push(current);
      newLine = Number(header[1]);
      continue;
    }
    if (!current) continue;
    // `\ No newline at end of file` is diff metadata, not a reviewable line.
    if (raw.startsWith('\\')) continue;

    if (raw.startsWith('+')) {
      current.lines.push({ kind: 'added', content: raw.slice(1), newLine });
      current.hasAdditions = true;
      newLine++;
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'removed', content: raw.slice(1) });
      current.hasDeletions = true;
    } else {
      current.lines.push({ kind: 'context', content: raw.startsWith(' ') ? raw.slice(1) : raw });
      newLine++;
    }
  }

  return hunks;
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
  return [fileHeader(file), '', rendered.join('\n\n')].join('\n');
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

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Candidate {
  file: ReviewerPatchFile;
  /** Additions-only form. Null when the file removed lines and added none. */
  newOnly: string | null;
  full: string;
  hasDeletions: boolean;
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
      estimatedTokens: 0,
      truncated: false,
    };
  }

  const deleted: ReviewerPatchFile[] = [];
  const noPatch: ReviewerPatchFile[] = [];
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
    const hunks = parseHunks(file.patch);
    const full = renderFileBlock(file, hunks, true);
    if (!full) {
      noPatch.push(file);
      continue;
    }
    candidates.push({
      file,
      newOnly: renderFileBlock(file, hunks, false),
      full,
      hasDeletions: hunks.some((h) => h.hasDeletions),
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
    estimatePatchTokens(noPatchSection(noPatch));
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

  const text = [
    summary,
    ...selected.map((e) => e.body),
    overflowSection(overflow),
    deletedSection(deleted),
    noPatchSection(noPatch),
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    text,
    includedFiles: selected.map((e) => e.candidate.file.filename),
    omittedFiles: [
      ...overflow.map((f) => ({ filename: f.filename, reason: 'token-budget' as const })),
      ...deleted.map((f) => ({ filename: f.filename, reason: 'deleted' as const })),
      ...noPatch.map((f) => ({ filename: f.filename, reason: 'no-patch' as const })),
    ],
    deletionsStripped,
    estimatedTokens: estimatePatchTokens(text),
    truncated: overflow.length > 0 || deletionsStripped.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

interface GithubPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string | null;
  previous_filename?: string | null;
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

    return renderReviewerPatch(
      files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch: f.patch ?? null,
        previousFilename: f.previous_filename ?? null,
      })),
      { tokenBudget: params.tokenBudget },
    );
  } catch (err) {
    console.warn(`[reviewer-patch] Failed to fetch patch for PR #${params.prNumber}:`, err);
    return null;
  }
}
