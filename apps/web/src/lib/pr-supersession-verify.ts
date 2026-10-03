/**
 * Content verification for automatic PR supersession — the pure half.
 *
 * A closed-unmerged PR is only ever recorded as superseded when its CHANGES
 * can be found in a merged candidate PR. Text that claims a supersession
 * ("superseded by #N" in a close comment, a cross-reference, shared task
 * lineage) only nominates a candidate; it never decides. PRs #2556 and #2563
 * were closed as "superseded by #N" where #N carried none of their work, and
 * that is exactly what these functions exist to refuse.
 *
 * Two methods, both computed from what GitHub's REST API returns for a PR's
 * files or a commit's files (`filename`, `status`, `sha`, `patch`):
 *
 *  - patch-id: per-commit equivalence, git patch-id style — only the +/- lines
 *    and the file they belong to are hashed, with all whitespace removed and
 *    hunk line numbers dropped. Verified when EVERY closed-PR commit has an
 *    equivalent commit in the candidate. Exact, so it catches cherry-picks and
 *    rebases, and misses squashes.
 *
 *  - content: the closed PR's added lines found among the lines the candidate
 *    itself ADDED (its own diff, not the file it touched), with paths mapped
 *    across a move. Catches squashes, rewrites and cross-repo relocations.
 *
 * Content matching tolerance (`CONTENT_MATCH`):
 *  - A line is compared trimmed. Blank lines, lines shorter than
 *    `minLineLength`, and lines made only of punctuation (`}`, `});`) are
 *    ignored — they match anywhere and prove nothing.
 *  - A closed file maps to a candidate file by identical blob sha first (an
 *    exact copy, at any path), then by identical path, then by the longest
 *    shared path suffix that includes the file name (`design/x.md` →
 *    `buildd/design/x.md`, the cross-repo move).
 *  - Attribution: a line counts only if the CANDIDATE added it. When GitHub
 *    omitted the candidate's patch (large file), the file's contents at the
 *    candidate's merge commit stand in, and only for a file the candidate
 *    created — a modified file's contents include whatever was already there.
 *  - Verified when at least `minLineRatio` of the closed PR's significant
 *    added lines are found AND there are at least `minSignificantLines` of
 *    them (or every file is an exact blob copy). A PR too small to clear that
 *    floor is left to patch-id or to a human.
 *  - Deletions are not checked: a removed file proves nothing about where the
 *    work went.
 */
import { createHash } from 'node:crypto';

export interface DiffFile {
  filename: string;
  status?: string | null;
  /** Blob sha of the file after the change (GitHub `sha`). */
  sha?: string | null;
  /** Unified diff for this file. GitHub omits it for binary and very large files. */
  patch?: string | null;
}

export const CONTENT_MATCH = {
  minLineLength: 4,
  minLineRatio: 0.9,
  minSignificantLines: 3,
} as const;

/** git's empty blob — an empty file "matches" every other empty file. */
const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

// ─── Claims ──────────────────────────────────────────────────────────────────

export interface SupersessionClaim {
  repo: string;
  prNumber: number;
}

const CLAIM_RE =
  /\b(?:duplicate\s+of|superseded\s+by|supersed(?:es|ing)\s+by|in\s+favou?r\s+of|replaced\s+by|landed\s+(?:in|via|as))\s*:?\s*(?:PR\s*)?(?:https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)|(?:([\w.-]+\/[\w.-]+))?#(\d+))/gi;

/**
 * Supersession claims in free text (a PR body, a close comment). A candidate
 * signal only — see the module doc.
 */
export function parseSupersessionClaims(text: string | null | undefined, defaultRepo: string): SupersessionClaim[] {
  const out: SupersessionClaim[] = [];
  const seen = new Set<string>();
  for (const m of (text ?? '').matchAll(CLAIM_RE)) {
    const repo = m[1] ?? m[3] ?? defaultRepo;
    const prNumber = Number(m[2] ?? m[4]);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;
    const key = `${repo.toLowerCase()}#${prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, prNumber });
  }
  return out;
}

// ─── Lines ───────────────────────────────────────────────────────────────────

function isSignificant(line: string): boolean {
  return line.length >= CONTENT_MATCH.minLineLength && /[A-Za-z0-9]/.test(line);
}

/** Lines a patch adds, trimmed, minus the ones that would match anywhere. */
export function significantAddedLines(patch: string | null | undefined): string[] {
  if (!patch) return [];
  const out: string[] = [];
  for (const raw of patch.split('\n')) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1).trim();
    if (isSignificant(line)) out.push(line);
  }
  return out;
}

function significantContentLines(content: string): string[] {
  return content.split('\n').map(l => l.trim()).filter(isSignificant);
}

// ─── patch-id ────────────────────────────────────────────────────────────────

/**
 * A git-patch-id-like fingerprint of one commit's diff: file name plus its
 * +/- lines with whitespace stripped, hunk headers dropped. Null when any file
 * lacks a patch — an incomplete diff cannot be fingerprinted honestly.
 */
export function patchIdOf(files: ReadonlyArray<DiffFile>): string | null {
  if (files.length === 0) return null;
  const hash = createHash('sha1');
  let any = false;
  for (const f of [...files].sort((a, b) => a.filename.localeCompare(b.filename))) {
    if (f.patch == null) return null;
    hash.update(`file:${f.filename}\n`);
    for (const raw of f.patch.split('\n')) {
      if ((raw.startsWith('+') && !raw.startsWith('+++')) || (raw.startsWith('-') && !raw.startsWith('---'))) {
        hash.update(raw[0] + raw.slice(1).replace(/\s+/g, '') + '\n');
        any = true;
      }
    }
  }
  return any ? hash.digest('hex') : null;
}

export interface PatchIdVerdict {
  verified: boolean;
  matched: number;
  total: number;
}

export function verifyByPatchId(
  closedCommits: ReadonlyArray<ReadonlyArray<DiffFile>>,
  candidateCommits: ReadonlyArray<ReadonlyArray<DiffFile>>,
): PatchIdVerdict {
  const candidateIds = new Set(candidateCommits.map(patchIdOf).filter((id): id is string => id != null));
  let matched = 0;
  let total = 0;
  for (const c of closedCommits) {
    const id = patchIdOf(c);
    // A merge commit or an empty commit has no diff to carry; skip it. A commit
    // whose patch GitHub withheld cannot be checked, so it fails the whole set.
    if (c.length === 0) continue;
    total++;
    if (id && candidateIds.has(id)) matched++;
  }
  return { verified: total > 0 && matched === total, matched, total };
}

// ─── content ─────────────────────────────────────────────────────────────────

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Number of trailing path segments two paths share. */
function sharedSuffixSegments(a: string, b: string): number {
  const as = a.split('/').reverse();
  const bs = b.split('/').reverse();
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

/** Map a closed-PR path to the candidate file that most plausibly holds it. */
export function mapPath(closedPath: string, candidateFiles: ReadonlyArray<DiffFile>): DiffFile | null {
  const live = candidateFiles.filter(f => f.status !== 'removed');
  const exact = live.find(f => f.filename === closedPath);
  if (exact) return exact;
  let best: DiffFile | null = null;
  let bestScore = 0;
  for (const f of live) {
    if (baseName(f.filename) !== baseName(closedPath)) continue;
    const score = sharedSuffixSegments(f.filename, closedPath);
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

export interface ContentVerdict {
  verified: boolean;
  /** Found / total significant lines (0 when there are none). */
  ratio: number;
  matchedLines: number;
  totalLines: number;
  /** Closed files whose exact blob appears in the candidate. */
  blobMatches: number;
  /** Closed files considered (removed files are not). */
  files: number;
}

/**
 * Whether the closed PR's added content is present in the candidate's own
 * diff. `candidateContents` holds file contents at the candidate's merge
 * commit, keyed by candidate path, for files whose patch GitHub omitted.
 */
export function verifyByContent(
  closedFiles: ReadonlyArray<DiffFile>,
  candidateFiles: ReadonlyArray<DiffFile>,
  candidateContents: ReadonlyMap<string, string> = new Map(),
): ContentVerdict {
  let matchedLines = 0;
  let totalLines = 0;
  let blobMatches = 0;
  let files = 0;
  let allBlobs = true;

  for (const f of closedFiles) {
    if (f.status === 'removed') continue;
    files++;
    const lines = significantAddedLines(f.patch);

    const blobTwin = f.sha && f.sha !== EMPTY_BLOB_SHA
      ? candidateFiles.find(c => c.status !== 'removed' && c.sha === f.sha)
      : undefined;
    if (blobTwin) {
      blobMatches++;
      const n = Math.max(lines.length, 1);
      matchedLines += n;
      totalLines += n;
      continue;
    }
    allBlobs = false;

    if (lines.length === 0) {
      // Nothing comparable (binary, or a patch GitHub withheld): one unit,
      // unmatched, so it cannot be waved through.
      totalLines += f.patch ? 0 : 1;
      continue;
    }
    totalLines += lines.length;

    const target = mapPath(f.filename, candidateFiles);
    if (!target) continue;
    let pool: string[];
    if (target.patch != null) {
      pool = significantAddedLines(target.patch);
    } else if (target.status === 'added' && candidateContents.has(target.filename)) {
      pool = significantContentLines(candidateContents.get(target.filename)!);
    } else {
      continue;
    }
    const set = new Set(pool);
    for (const l of lines) if (set.has(l)) matchedLines++;
  }

  const ratio = totalLines > 0 ? matchedLines / totalLines : 0;
  const enough = totalLines >= CONTENT_MATCH.minSignificantLines || (files > 0 && allBlobs);
  return {
    verified: files > 0 && enough && ratio >= CONTENT_MATCH.minLineRatio,
    ratio,
    matchedLines,
    totalLines,
    blobMatches,
    files,
  };
}
