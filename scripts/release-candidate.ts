#!/usr/bin/env bun
/**
 * Frozen release candidates: cut `release/vX.Y.Z` from ONE captured `dev` SHA and
 * open it as the single release PR into `main`.
 *
 * Why: the release PR used to be `dev → main`. Its head was `dev`, so every
 * merge after the cut landed in it, release-refresh.yml rewrote its version and
 * pushed bump commits onto `dev`, and nothing a reviewer approved or CI verified
 * was the thing that merged. A candidate here is `dev@<captured SHA>` plus exactly
 * one release-only commit (package.json versions + CHANGELOG promotion), on its
 * own branch. `dev` is never written to. The candidate never moves unless an
 * operator explicitly amends it, and an amendment voids every check and approval
 * on the old SHA.
 *
 * One engine for both entry points: `.github/workflows/release.yml` runs it with
 * `--source ${{ github.sha }}` (a re-run of the same workflow run reuses that SHA,
 * so a re-run can never pick up a dev that moved), and `bun run release:candidate`
 * runs the same code from a workstation.
 *
 * CLI:
 *   cut    --source <sha|ref> [--force] [--dry-run]
 *            Idempotent. An open candidate → reported, never changed. An
 *            unpublished candidate branch (push landed, PR create died) → its PR
 *            is opened, its content is not rebuilt.
 *   amend  --candidate vX.Y.Z --confirm vX.Y.Z --source <sha|ref> [--dry-run]
 *            Explicit operator re-cut of the open candidate from a newer dev SHA.
 *   reconcile-changelog --base F --ours F --theirs F
 *            sync-dev.yml's resolver when merging main (carrying a promoted
 *            CHANGELOG) back into dev (carrying new [Unreleased] entries).
 * Common flags: --repo owner/name, --remote origin, --source-branch dev,
 *   --base-branch main, --package-files "a b", --version-file apps/web/package.json,
 *   --today YYYY-MM-DD.
 *
 * Writes `status`, `version`, `branch`, `source_sha`, `candidate_sha`, `pr_number`
 * to $GITHUB_OUTPUT and a summary to $GITHUB_STEP_SUMMARY when those are set.
 */

import { spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bumpClass, compareSemver, nextVersion, DEFAULT_PACKAGE_FILES, type BumpClass } from './release-bump';

// ── Pure helpers ─────────────────────────────────────────────────────────────

export const CANDIDATE_BRANCH_RE = /^release\/v(\d+\.\d+\.\d+)$/;
const SEMVER_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

export function candidateBranch(version: string): string {
  return `release/v${version.replace(/^v/, '')}`;
}

export function candidateVersionOf(ref: string | null | undefined): string | null {
  const m = CANDIDATE_BRANCH_RE.exec((ref ?? '').trim());
  return m ? m[1] : null;
}

export function bumpSubject(version: string): string {
  return `chore: bump version to v${version.replace(/^v/, '')}`;
}

/** Subjects the release automation itself writes; they never decide a bump. */
const RELEASE_ARTIFACT_SUBJECT_RE = /^(chore: bump version to v\d+\.\d+\.\d+|docs: promote CHANGELOG for upcoming release)/;
const MAJOR_RE = /BREAKING[ -]CHANGE|^[a-z]+!:/i;
const SHIPPABLE_RE = /^(feat|fix)(\(.+\))?!?:/;

export function releasableSubjects(subjects: string[]): string[] {
  return subjects.map((s) => s.trim()).filter((s) => s && !RELEASE_ARTIFACT_SUBJECT_RE.test(s));
}

/** Same rule the shared reusable workflow used: something a user would notice. */
export function isShippable(subjects: string[]): boolean {
  return releasableSubjects(subjects).some((s) => SHIPPABLE_RE.test(s) || MAJOR_RE.test(s));
}

/** Highest `vX.Y.Z` tag by numeric order (prerelease/odd tags ignored), or null. */
export function latestSemverTag(tags: string[]): string | null {
  const clean = tags.map((t) => t.trim()).filter((t) => SEMVER_TAG_RE.test(t));
  if (clean.length === 0) return null;
  return clean.sort((a, b) => compareSemver(b, a))[0];
}

export interface VersionPlan {
  bump: BumpClass;
  /** The version the bump is applied to: max(latest tag, main's package.json). */
  base: string;
  version: string;
}

/**
 * The base is the higher of the latest tag and what main already claims: an
 * untagged prior ship (main's package.json ahead of every tag) must not be
 * re-issued. Same rule release.sh --hotfix uses.
 */
export function planVersion(opts: { latestTag: string | null; mainVersion: string | null; subjects: string[] }): VersionPlan {
  const candidates = [opts.latestTag ?? '0.0.0', opts.mainVersion ?? '0.0.0'].map((v) => v.replace(/^v/, ''));
  const base = candidates.sort((a, b) => compareSemver(b, a))[0];
  const bump = bumpClass(releasableSubjects(opts.subjects));
  return { bump, base, version: nextVersion(base, bump) };
}

/** Pull request numbers a commit subject credits: `(#123)` suffixes and merge commits. */
export function prNumbersIn(subject: string): number[] {
  const out: number[] = [];
  const merge = /^Merge pull request #(\d+)/.exec(subject);
  if (merge) out.push(Number(merge[1]));
  for (const m of subject.matchAll(/\(#(\d+)\)/g)) out.push(Number(m[1]));
  return out;
}

/**
 * Promote [Unreleased] to `## [version] - today`, exactly as scripts/release.sh
 * always has (Tag Release's "Verify CHANGELOG promotion" step expects this shape).
 * Unchanged when [Unreleased] has no bullet entries.
 */
export function promoteChangelog(content: string, version: string, today: string, prevTag: string, repo: string): string {
  const m = /^## \[Unreleased\]([\s\S]*?)(?=^## \[)/m.exec(content);
  if (!m || !/^- /m.test(m[1])) return content;
  return content
    .replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - ${today}\n`)
    .replace(
      /^\[Unreleased\]:.*$/m,
      `[Unreleased]: https://github.com/${repo}/compare/v${version}...HEAD\n[${version}]: https://github.com/${repo}/compare/${prevTag}...v${version}`,
    );
}

interface UnreleasedSplit {
  head: string;
  body: string;
  tail: string;
}

/** `head` ends with the `## [Unreleased]` line; `body` runs to the next section or footer link. */
export function splitUnreleased(content: string): UnreleasedSplit | null {
  const m = /^## \[Unreleased\][^\n]*\n/m.exec(content);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = /^(## \[|\[[^\]\n]+\]: )/m.exec(content.slice(start));
  const end = next ? start + next.index : content.length;
  return { head: content.slice(0, start), body: content.slice(start, end), tail: content.slice(end) };
}

/** Bullet entries (a `- ` line plus its indented continuation lines), keyed by the bullet line. */
function entriesOf(body: string): Array<{ key: string; lines: string[] }> {
  const out: Array<{ key: string; lines: string[] }> = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('- ')) out.push({ key: line.trimEnd(), lines: [line] });
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1].lines.push(line);
  }
  return out;
}

/**
 * Merge main's CHANGELOG (a candidate promoted [Unreleased] into a version
 * section) back into dev's (which kept adding [Unreleased] entries after the
 * cut). Result: main's file, whose [Unreleased] holds dev's entries minus the
 * ones main has now released.
 *
 * Refuses (throws) when dev changed anything OUTSIDE [Unreleased] since the
 * merge base: silently picking a side there could drop a correction someone
 * made to an old release's notes.
 */
export function reconcileChangelog(base: string, ours: string, theirs: string): string {
  const b = splitUnreleased(base);
  const o = splitUnreleased(ours);
  const t = splitUnreleased(theirs);
  if (!b || !o || !t) throw new Error('CHANGELOG.md has no [Unreleased] section on one side; reconcile by hand');
  if (o.head + o.tail !== b.head + b.tail) {
    throw new Error('dev changed CHANGELOG.md outside [Unreleased] since it diverged from main; reconcile by hand');
  }
  const released = new Set(entriesOf(t.head + t.tail).map((e) => e.key));
  const keep = (key: string) => !released.has(key);

  const lines: string[] = [];
  let skipping = false;
  for (const line of o.body.split('\n')) {
    if (line.startsWith('- ')) {
      skipping = !keep(line.trimEnd());
      if (!skipping) lines.push(line);
    } else if (skipping && /^\s+\S/.test(line)) {
      continue; // continuation of a released entry
    } else {
      skipping = false;
      lines.push(line);
    }
  }
  const ourKeys = new Set(entriesOf(o.body).map((e) => e.key));
  for (const e of entriesOf(t.body)) {
    if (!ourKeys.has(e.key) && keep(e.key)) lines.push(...e.lines);
  }

  // Drop `### Heading`s left with no entries under them.
  const pruned: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('### ')) {
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith('### ') && !lines[j].startsWith('- ')) j++;
      if (j >= lines.length || lines[j].startsWith('### ')) continue;
    }
    pruned.push(lines[i]);
  }
  const text = pruned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.head + (text ? `\n${text}\n\n` : '\n') + t.tail;
}

// ── PR body ──────────────────────────────────────────────────────────────────

export interface CandidateMeta {
  schema: 1;
  version: string;
  branch: string;
  sourceRef: string;
  sourceSha: string;
  candidateSha: string;
  baseRef: string;
  baseSha: string;
  previousTag: string | null;
  bump: BumpClass;
  /** 0 for the original cut; each explicit amendment adds one. */
  amendment: number;
  previousCandidateSha: string | null;
  /** PR number of the candidate this one replaced (an amendment that changed the version). */
  supersedes: number | null;
  cutAt: string;
}

const META_RE = /<!-- release-candidate (\{[\s\S]*?\}) -->/;
const EXCLUDED_START = '<!-- release-candidate:excluded:start -->';
const EXCLUDED_END = '<!-- release-candidate:excluded:end -->';

/**
 * The required checks a candidate must pass, by check-run name. `build` is the
 * one branch protection on main already requires; `release candidate verified`
 * is build.yml's aggregate over the candidate's shape check and
 * `candidate integration / integration` (full API + runner integration at the
 * exact candidate SHA).
 */
export const REQUIRED_CANDIDATE_CHECKS = ['build', 'release candidate verified', 'Schema Drift / check-prod'];

export function parseCandidateMeta(body: string | null | undefined): CandidateMeta | null {
  const m = META_RE.exec(body ?? '');
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]);
    return meta && meta.schema === 1 ? (meta as CandidateMeta) : null;
  } catch {
    return null;
  }
}

export interface CommitLine {
  sha: string;
  subject: string;
}

const MAX_LISTED = 150;

function listCommits(commits: CommitLine[], empty: string): string {
  if (commits.length === 0) return empty;
  const shown = commits.slice(0, MAX_LISTED).map((c) => `- \`${c.sha.slice(0, 9)}\` ${c.subject}`);
  if (commits.length > MAX_LISTED) shown.push(`- … and ${commits.length - MAX_LISTED} more (see the compare view)`);
  return shown.join('\n');
}

export function renderExcluded(excluded: CommitLine[]): string {
  return `${EXCLUDED_START}\n${listCommits(excluded, '_Nothing yet: `dev` has not moved past the captured SHA._')}\n${EXCLUDED_END}`;
}

export function renderCandidateBody(meta: CandidateMeta, included: CommitLine[], excluded: CommitLine[], repo: string): string {
  const prs = [...new Set(included.flatMap((c) => prNumbersIn(c.subject)))].sort((a, b) => a - b);
  const prev = meta.previousTag ?? '(first release)';
  const amendment =
    meta.amendment === 0
      ? '0 (original cut)'
      : `${meta.amendment}${meta.previousCandidateSha ? ` (replaced \`${meta.previousCandidateSha}\`)` : ''}${
          meta.supersedes ? `, supersedes #${meta.supersedes}` : ''
        }`;
  const compare = meta.previousTag
    ? `https://github.com/${repo}/compare/${meta.previousTag}...${meta.sourceSha}`
    : `https://github.com/${repo}/commits/${meta.sourceSha}`;
  return [
    `## Release v${meta.version} (frozen candidate)`,
    '',
    '| | |',
    '|---|---|',
    `| Version | \`v${meta.version}\` (${meta.bump} over \`${prev}\`) |`,
    `| Candidate branch | \`${meta.branch}\` → \`${meta.baseRef}\` |`,
    `| Captured \`${meta.sourceRef}\` SHA | \`${meta.sourceSha}\` |`,
    `| Candidate SHA (what merges) | \`${meta.candidateSha}\` |`,
    `| \`${meta.baseRef}\` at cut | \`${meta.baseSha}\` |`,
    `| Amendment | ${amendment} |`,
    `| Cut at | ${meta.cutAt} |`,
    '',
    `This branch is \`${meta.sourceRef}\` at the captured SHA plus one release-only commit (package versions + CHANGELOG). ` +
      `It does not move when \`${meta.sourceRef}\` moves. Only an explicit amendment (Release workflow, \`amend\` input, ` +
      'typed twice) changes it, and an amendment voids every check result and approval on the old SHA.',
    '',
    `### Included pull requests (${prs.length})`,
    prs.length ? prs.map((n) => `- #${n}`).join('\n') : '_None referenced by number._',
    '',
    `### Included commits (${included.length}) · [compare](${compare})`,
    listCommits(included, '_None._'),
    '',
    `### Not in this candidate (landed on \`${meta.sourceRef}\` after the cut)`,
    renderExcluded(excluded),
    '',
    '### Required before merge',
    ...REQUIRED_CANDIDATE_CHECKS.map((c) => `- [ ] \`${c}\` green on \`${meta.candidateSha.slice(0, 12)}\``),
    '- [ ] Aggregate review approved on this exact candidate SHA',
    '',
    `After merge, Tag Release tags \`v${meta.version}\` from \`apps/web/package.json\` on \`${meta.baseRef}\`, and sync-dev merges ` +
      `\`${meta.baseRef}\` back into \`${meta.sourceRef}\` (never a reset). The release is not shipped until the deployed SHA matches \`${meta.baseRef}\`.`,
    '',
    `<!-- release-candidate ${JSON.stringify(meta)} -->`,
  ].join('\n');
}

/** Replace only the excluded-commits section; everything that describes the candidate stays put. */
export function replaceExcluded(body: string, excluded: CommitLine[]): string {
  const s = body.indexOf(EXCLUDED_START);
  const e = body.indexOf(EXCLUDED_END);
  if (s < 0 || e < s) return body;
  return body.slice(0, s) + renderExcluded(excluded) + body.slice(e + EXCLUDED_END.length);
}

// ── Process plumbing ─────────────────────────────────────────────────────────

class Refusal extends Error {}

interface Ctx {
  cwd: string;
  repo: string;
  remote: string;
  sourceBranch: string;
  baseBranch: string;
  packageFiles: string[];
  versionFile: string;
  today: string;
  dryRun: boolean;
}

function sh(cwd: string, cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function git(cwd: string, ...args: string[]): string {
  const r = sh(cwd, 'git', args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function gitOk(cwd: string, ...args: string[]): boolean {
  return sh(cwd, 'git', args).status === 0;
}

function gh(ctx: Ctx, args: string[], input?: string): string {
  const r = sh(ctx.cwd, 'gh', args, input);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function output(values: Record<string, string | number | null | undefined>): void {
  const file = process.env.GITHUB_OUTPUT;
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v ?? ''}`;
    console.log(`  ${line}`);
    if (file) appendFileSync(file, line + '\n');
  }
}

function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, markdown + '\n');
}

const remoteRef = (ctx: Ctx, branch: string) => `refs/remotes/${ctx.remote}/${branch}`;

function fetchAll(ctx: Ctx): void {
  // Every branch and every tag origin has: a tag only origin knows (a concurrent
  // release) must count, and so must a candidate branch another run just pushed.
  git(ctx.cwd, 'fetch', '--quiet', '--force', '--tags', ctx.remote, `+refs/heads/*:refs/remotes/${ctx.remote}/*`);
}

function resolveSha(ctx: Ctx, ref: string): string {
  const r = sh(ctx.cwd, 'git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (r.status !== 0 || !r.stdout) throw new Refusal(`cannot resolve ${ref} to a commit`);
  return r.stdout;
}

const isAncestor = (ctx: Ctx, a: string, b: string) => gitOk(ctx.cwd, 'merge-base', '--is-ancestor', a, b);

function commitsIn(ctx: Ctx, range: string, noMerges = true): CommitLine[] {
  const out = git(ctx.cwd, 'log', ...(noMerges ? ['--no-merges'] : []), '--format=%H %s', range);
  return out
    ? out.split('\n').map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }))
    : [];
}

function readVersionAt(ctx: Ctx, rev: string): string | null {
  const r = sh(ctx.cwd, 'git', ['show', `${rev}:${ctx.versionFile}`]);
  if (r.status !== 0) return null;
  try {
    const v = JSON.parse(r.stdout).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

interface OpenPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  body: string;
  url: string;
  isCrossRepository?: boolean;
}

function openPrsIntoBase(ctx: Ctx): OpenPr[] {
  // --limit: gh's default page is 30; missing a colliding PR must not pass.
  const raw = gh(ctx, [
    'pr', 'list', '--repo', ctx.repo, '--base', ctx.baseBranch, '--state', 'open', '--limit', '500',
    '--json', 'number,title,headRefName,headRefOid,body,url,isCrossRepository',
  ]);
  return JSON.parse(raw || '[]') as OpenPr[];
}

function openCandidates(prs: OpenPr[]): OpenPr[] {
  return prs.filter((p) => !p.isCrossRepository && candidateVersionOf(p.headRefName) !== null);
}

function prsForHead(ctx: Ctx, branch: string): Array<{ number: number; state: string }> {
  const raw = gh(ctx, ['pr', 'list', '--repo', ctx.repo, '--head', branch, '--state', 'all', '--limit', '50', '--json', 'number,state']);
  return JSON.parse(raw || '[]');
}

function patchBody(ctx: Ctx, number: number, body: string): void {
  gh(ctx, ['api', '--method', 'PATCH', `repos/${ctx.repo}/pulls/${number}`, '--input', '-'], JSON.stringify({ body }));
}

// ── Building a candidate commit ──────────────────────────────────────────────

/**
 * Build `source + one release commit` in a throwaway worktree and return its
 * SHA. Nothing is pushed and the caller's checkout is untouched.
 */
function buildCandidate(ctx: Ctx, source: string, version: string, previousTag: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-candidate-'));
  const wt = join(dir, 'wt');
  git(ctx.cwd, 'worktree', 'add', '--quiet', '--detach', wt, source);
  try {
    const touched: string[] = [];
    for (const file of ctx.packageFiles) {
      const p = join(wt, file);
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, 'utf8');
      const json = JSON.parse(raw);
      const indent = /^\{\n([ \t]+)/.exec(raw)?.[1] ?? '  ';
      json.version = version;
      writeFileSync(p, JSON.stringify(json, null, indent) + '\n');
      touched.push(file);
    }
    if (touched.length === 0) throw new Refusal(`none of the package files exist at ${source}: ${ctx.packageFiles.join(', ')}`);
    const changelog = join(wt, 'CHANGELOG.md');
    if (existsSync(changelog)) {
      const before = readFileSync(changelog, 'utf8');
      const after = promoteChangelog(before, version, ctx.today, previousTag ?? 'v0.0.0', ctx.repo);
      if (after !== before) {
        writeFileSync(changelog, after);
        touched.push('CHANGELOG.md');
      }
    }
    git(wt, 'add', '--', ...touched);
    if (gitOk(wt, 'diff', '--cached', '--quiet')) {
      throw new Refusal(`v${version} changes no file at ${source.slice(0, 12)}: the source already carries this version`);
    }
    const message = [
      bumpSubject(version),
      '',
      `Release-Candidate: v${version}`,
      `Release-Source: ${ctx.sourceBranch}@${source}`,
      `Release-Previous-Tag: ${previousTag ?? 'none'}`,
    ].join('\n');
    git(wt, 'commit', '--quiet', '--no-verify', '-m', message);
    return git(wt, 'rev-parse', 'HEAD');
  } finally {
    sh(ctx.cwd, 'git', ['worktree', 'remove', '--force', wt]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Is `sha` a candidate commit this engine built: one parent, the bump subject
 * for `version`, and only release paths touched? Anything else on a
 * `release/v*` branch is someone else's work and is never reused or overwritten.
 */
function isCandidateCommit(ctx: Ctx, sha: string, version: string): boolean {
  const parents = git(ctx.cwd, 'rev-list', '--parents', '-n', '1', sha).split(' ');
  if (parents.length !== 2) return false;
  if (git(ctx.cwd, 'log', '-1', '--format=%s', sha) !== bumpSubject(version)) return false;
  const files = git(ctx.cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha).split('\n').filter(Boolean);
  return files.length > 0 && files.every((f) => f === 'CHANGELOG.md' || f.endsWith('package.json'));
}

/** Create-only push: fails if the branch already exists, so two cuts cannot both win. */
function pushCreate(ctx: Ctx, sha: string, branch: string): boolean {
  return gitOk(ctx.cwd, 'push', '--quiet', `--force-with-lease=refs/heads/${branch}:`, ctx.remote, `${sha}:refs/heads/${branch}`);
}

function createPr(ctx: Ctx, branch: string, title: string, body: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'release-candidate-body-'));
  const file = join(dir, 'body.md');
  writeFileSync(file, body);
  try {
    const url = gh(ctx, ['pr', 'create', '--repo', ctx.repo, '--base', ctx.baseBranch, '--head', branch, '--title', title, '--body-file', file]);
    const m = /\/pull\/(\d+)/.exec(url);
    if (!m) throw new Error(`gh pr create returned no PR URL: ${url}`);
    return Number(m[1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Shared pre-flight ────────────────────────────────────────────────────────

interface Snapshot {
  sourceSha: string;
  baseSha: string;
  latestTag: string | null;
  plan: VersionPlan;
  included: CommitLine[];
  subjects: string[];
}

function snapshot(ctx: Ctx, sourceSha: string): Snapshot {
  if (!gitOk(ctx.cwd, 'rev-parse', '--verify', '--quiet', remoteRef(ctx, ctx.baseBranch))) {
    throw new Refusal(`${ctx.remote}/${ctx.baseBranch} does not exist`);
  }
  const baseSha = resolveSha(ctx, remoteRef(ctx, ctx.baseBranch));
  if (!isAncestor(ctx, sourceSha, remoteRef(ctx, ctx.sourceBranch))) {
    throw new Refusal(
      `${sourceSha.slice(0, 12)} is not on ${ctx.sourceBranch}. A candidate is cut only from a commit ${ctx.sourceBranch} has reviewed and merged.`,
    );
  }
  if (!isAncestor(ctx, baseSha, sourceSha)) {
    // A hotfix (or anything else) landed on main and has not been merged back
    // into dev yet. Cutting here would produce a candidate that conflicts with
    // main on the version lines, or silently reverts the hotfix.
    const missing = commitsIn(ctx, `${sourceSha}..${baseSha}`);
    throw new Refusal(
      `${ctx.baseBranch} has ${missing.length} commit(s) that ${ctx.sourceBranch}@${sourceSha.slice(0, 12)} does not ` +
        `(${missing.slice(0, 3).map((c) => c.subject).join('; ')}). Let sync-dev merge ${ctx.baseBranch} into ${ctx.sourceBranch} ` +
        `(or run: git checkout ${ctx.sourceBranch} && git merge ${ctx.remote}/${ctx.baseBranch} && git push), then cut again.`,
    );
  }
  const latestTag = latestSemverTag(git(ctx.cwd, 'tag', '--list', 'v*').split('\n'));
  const range = latestTag && isAncestor(ctx, latestTag, sourceSha) ? `${latestTag}..${sourceSha}` : `${baseSha}..${sourceSha}`;
  const included = commitsIn(ctx, range);
  const subjects = included.map((c) => c.subject);
  const plan = planVersion({ latestTag, mainVersion: readVersionAt(ctx, baseSha), subjects });
  return { sourceSha, baseSha, latestTag, plan, included, subjects };
}

function assertVersionFree(ctx: Ctx, version: string, open: OpenPr[], ignore: number | null = null): void {
  if (gitOk(ctx.cwd, 'rev-parse', '--verify', '--quiet', `refs/tags/v${version}`)) {
    throw new Refusal(`v${version} is already tagged. Refusing to open a candidate Tag Release could never tag.`);
  }
  const clash = open.find((p) => p.number !== ignore && new RegExp(`^(Release|Hotfix) v${version.replace(/\./g, '\\.')}([^0-9.]|$)`).test(p.title));
  if (clash) {
    throw new Refusal(`#${clash.number} ("${clash.title}") already claims v${version}. Merge or close it first, then cut again.`);
  }
}

function baseMeta(ctx: Ctx, snap: Snapshot, version: string, candidateSha: string): CandidateMeta {
  return {
    schema: 1,
    version,
    branch: candidateBranch(version),
    sourceRef: ctx.sourceBranch,
    sourceSha: snap.sourceSha,
    candidateSha,
    baseRef: ctx.baseBranch,
    baseSha: snap.baseSha,
    previousTag: snap.latestTag,
    bump: snap.plan.bump,
    amendment: 0,
    previousCandidateSha: null,
    supersedes: null,
    cutAt: new Date().toISOString(),
  };
}

function excludedSince(ctx: Ctx, sourceSha: string): CommitLine[] {
  return commitsIn(ctx, `${sourceSha}..${remoteRef(ctx, ctx.sourceBranch)}`);
}

/**
 * After opening a PR: if a parallel cut also opened one, the lowest PR number
 * wins and every other one closes itself. Only PRs this run opened are closed.
 */
function settleRace(ctx: Ctx, mine: number, ignore: number | null = null): boolean {
  const others = openCandidates(openPrsIntoBase(ctx)).filter((p) => p.number !== mine && p.number !== ignore);
  const winner = others.find((p) => p.number < mine);
  if (!winner) return true;
  gh(ctx, ['pr', 'close', String(mine), '--repo', ctx.repo, '--comment', `Closed automatically: a parallel cut opened #${winner.number} first, and there is only ever one release candidate for ${ctx.baseBranch}.`]);
  console.log(`::error::Lost a parallel cut to #${winner.number}; closed #${mine}.`);
  return false;
}

// ── cut ──────────────────────────────────────────────────────────────────────

export function cut(ctx: Ctx, source: string, force: boolean): number {
  fetchAll(ctx);
  const sourceSha = resolveSha(ctx, source);
  console.log(`Captured ${ctx.sourceBranch} SHA: ${sourceSha}`);

  const open = openPrsIntoBase(ctx);

  // A dev → main release PR from before this flow existed. It is never closed,
  // retargeted or edited here: it is allowed to finish (or an operator closes
  // it), and only then does the first candidate get cut.
  const legacy = open.find((p) => !p.isCrossRepository && p.headRefName === ctx.sourceBranch);
  if (legacy) {
    console.log(
      `::warning title=Legacy release PR still open::#${legacy.number} (${ctx.sourceBranch} → ${ctx.baseBranch}, "${legacy.title}") predates frozen candidates. ` +
        'It is left alone; merge or close it, then run the Release workflow again to cut the first candidate.',
    );
    output({ status: 'legacy-open', pr_number: legacy.number, source_sha: sourceSha });
    return 0;
  }

  const existing = openCandidates(open);
  if (existing.length > 1) {
    throw new Refusal(`more than one open release candidate (${existing.map((p) => `#${p.number}`).join(', ')}); close all but one.`);
  }
  if (existing.length === 1) return reportExisting(ctx, existing[0], sourceSha);

  if (isAncestor(ctx, sourceSha, remoteRef(ctx, ctx.baseBranch))) {
    console.log(`${ctx.sourceBranch}@${sourceSha.slice(0, 12)} is already in ${ctx.baseBranch}; nothing to release.`);
    output({ status: 'nothing', source_sha: sourceSha });
    return 0;
  }

  const snap = snapshot(ctx, sourceSha);
  const { version } = snap.plan;
  const branch = candidateBranch(version);
  console.log(`Previous tag: ${snap.latestTag ?? '(none)'} · ${snap.included.length} commit(s) · ${snap.plan.bump} bump → v${version}`);

  if (!force && !isShippable(snap.subjects)) {
    console.log(`No feat/fix commits since ${snap.latestTag ?? 'the start'}; nothing to release (re-run with force to cut anyway).`);
    output({ status: 'nothing', source_sha: sourceSha, version });
    return 0;
  }
  assertVersionFree(ctx, version, open);

  // The branch may already exist: a previous run pushed it and died before
  // `gh pr create`. Publish THAT candidate unchanged (its own source SHA, not
  // ours), so a re-run never folds newer dev commits into it.
  if (gitOk(ctx.cwd, 'rev-parse', '--verify', '--quiet', remoteRef(ctx, branch))) {
    return resumeUnpublished(ctx, branch, version, snap);
  }

  const candidateSha = buildCandidate(ctx, sourceSha, version, snap.latestTag);
  const meta = baseMeta(ctx, snap, version, candidateSha);
  const body = renderCandidateBody(meta, snap.included, excludedSince(ctx, sourceSha), ctx.repo);

  if (ctx.dryRun) {
    console.log(`\nDRY RUN: would push ${candidateSha} to ${branch} and open "Release v${version}" into ${ctx.baseBranch}.\n\n${body}`);
    output({ status: 'dry-run', version, branch, source_sha: sourceSha, candidate_sha: candidateSha });
    summary(`### Release candidate (dry run)\n\n${body}`);
    return 0;
  }

  if (!pushCreate(ctx, candidateSha, branch)) {
    // Someone created the branch between our fetch and our push.
    fetchAll(ctx);
    return resumeUnpublished(ctx, branch, version, snap);
  }
  console.log(`Pushed ${branch} at ${candidateSha}`);
  return publish(ctx, meta, body, null);
}

function publish(ctx: Ctx, meta: CandidateMeta, body: string, ignore: number | null): number {
  const number = createPr(ctx, meta.branch, `Release v${meta.version}`, body);
  console.log(`Opened #${number}: Release v${meta.version}`);
  if (!settleRace(ctx, number, ignore)) {
    output({ status: 'lost-race', version: meta.version, branch: meta.branch, pr_number: number });
    return 1;
  }
  output({
    status: 'created',
    version: meta.version,
    branch: meta.branch,
    source_sha: meta.sourceSha,
    candidate_sha: meta.candidateSha,
    pr_number: number,
  });
  summary(`### Release candidate v${meta.version} → #${number}\n\n- captured \`${meta.sourceRef}\` SHA \`${meta.sourceSha}\`\n- candidate SHA \`${meta.candidateSha}\``);
  return 0;
}

function resumeUnpublished(ctx: Ctx, branch: string, version: string, snap: Snapshot): number {
  const head = resolveSha(ctx, remoteRef(ctx, branch));
  const prior = prsForHead(ctx, branch);
  if (prior.some((p) => p.state !== 'OPEN')) {
    throw new Refusal(
      `${branch} already exists and its PR #${prior[0].number} is ${prior[0].state.toLowerCase()}: it is an abandoned or shipped candidate. ` +
        `It is not deleted automatically. Delete the branch deliberately (git push ${ctx.remote} --delete ${branch}) and cut again.`,
    );
  }
  if (prior.some((p) => p.state === 'OPEN')) {
    // A parallel cut won both the push and the PR; nothing left for us to do.
    console.log(`${branch} was published by a parallel cut as #${prior[0].number}.`);
    output({ status: 'existing', version, branch, candidate_sha: head, pr_number: prior[0].number });
    return 0;
  }
  if (!isCandidateCommit(ctx, head, version)) {
    throw new Refusal(`${branch} exists but its head ${head.slice(0, 12)} is not a candidate commit for v${version}; refusing to reuse or overwrite it.`);
  }
  const source = git(ctx.cwd, 'rev-parse', `${head}^`);
  if (!isAncestor(ctx, source, remoteRef(ctx, ctx.sourceBranch))) {
    throw new Refusal(`${branch} was cut from ${source.slice(0, 12)}, which is not on ${ctx.sourceBranch}; refusing to publish it.`);
  }
  console.log(`Resuming the unpublished cut on ${branch} (source ${source.slice(0, 12)}); it is published exactly as it was built.`);
  const resumed: Snapshot = source === snap.sourceSha ? snap : snapshot(ctx, source);
  const meta = baseMeta(ctx, resumed, version, head);
  const body = renderCandidateBody(meta, resumed.included, excludedSince(ctx, source), ctx.repo);
  if (ctx.dryRun) {
    output({ status: 'dry-run', version, branch, source_sha: source, candidate_sha: head });
    return 0;
  }
  return publish(ctx, meta, body, null);
}

function reportExisting(ctx: Ctx, pr: OpenPr, capturedSha: string): number {
  const version = candidateVersionOf(pr.headRefName)!;
  const meta = parseCandidateMeta(pr.body);
  console.log(`Release candidate #${pr.number} (${pr.headRefName}) is open; it is not changed. An amendment is the only way to move it.`);
  if (!meta) {
    console.log(`::warning::#${pr.number} carries no release-candidate metadata; it was not cut by this workflow.`);
    output({ status: 'existing', version, branch: pr.headRefName, candidate_sha: pr.headRefOid, pr_number: pr.number });
    return 0;
  }
  if (meta.candidateSha !== pr.headRefOid) {
    console.log(
      `::warning title=Candidate head moved::#${pr.number} head is ${pr.headRefOid}, but it was cut as ${meta.candidateSha}. ` +
        'Something other than an amendment pushed to the candidate branch; every check and approval must be redone on the new head.',
    );
  }
  if (!isAncestor(ctx, remoteRef(ctx, ctx.baseBranch), pr.headRefOid)) {
    console.log(
      `::warning title=${ctx.baseBranch} moved under the candidate::${ctx.baseBranch} gained commits after the cut (a hotfix?). ` +
        `Once sync-dev has merged them into ${ctx.sourceBranch}, amend the candidate (Release workflow, amend: v${version}).`,
    );
  }
  const excluded = excludedSince(ctx, meta.sourceSha);
  console.log(`${excluded.length} ${ctx.sourceBranch} commit(s) since the cut are excluded from it (this run captured ${capturedSha.slice(0, 12)}).`);
  const next = replaceExcluded(pr.body, excluded);
  if (next !== pr.body && !ctx.dryRun) {
    patchBody(ctx, pr.number, next);
    console.log(`Refreshed the "not in this candidate" list on #${pr.number}.`);
  }
  output({ status: 'existing', version, branch: pr.headRefName, source_sha: meta.sourceSha, candidate_sha: pr.headRefOid, pr_number: pr.number });
  summary(`### Release candidate #${pr.number} unchanged\n\n${excluded.length} later \`${ctx.sourceBranch}\` commit(s) excluded.`);
  return 0;
}

// ── amend ────────────────────────────────────────────────────────────────────

export function amend(ctx: Ctx, candidate: string, confirm: string, source: string): number {
  const want = candidate.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(want)) throw new Refusal(`amend: "${candidate}" is not a vX.Y.Z version`);
  if (confirm.replace(/^v/, '') !== want) {
    throw new Refusal(`amend: confirmation "${confirm}" does not match "${candidate}". An amendment voids checks and approvals; type the version twice.`);
  }
  fetchAll(ctx);
  const sourceSha = resolveSha(ctx, source);
  const open = openPrsIntoBase(ctx);
  const pr = openCandidates(open).find((p) => p.headRefName === candidateBranch(want));
  if (!pr) throw new Refusal(`no open release candidate ${candidateBranch(want)} to amend`);
  const meta = parseCandidateMeta(pr.body);
  if (!meta) throw new Refusal(`#${pr.number} carries no release-candidate metadata; it was not cut by this workflow, so it is not amended by it`);

  if (meta.sourceSha === sourceSha && meta.candidateSha === pr.headRefOid) {
    console.log(`#${pr.number} is already cut from ${sourceSha}; nothing to amend.`);
    output({ status: 'unchanged', version: want, branch: pr.headRefName, source_sha: sourceSha, candidate_sha: pr.headRefOid, pr_number: pr.number });
    return 0;
  }
  if (!isAncestor(ctx, meta.sourceSha, sourceSha)) {
    throw new Refusal(`amend: ${sourceSha.slice(0, 12)} does not descend from the candidate's source ${meta.sourceSha.slice(0, 12)}; an amendment only moves forward along ${ctx.sourceBranch}.`);
  }

  const snap = snapshot(ctx, sourceSha);
  const version = snap.plan.version;
  const candidateSha = buildCandidate(ctx, sourceSha, version, snap.latestTag);
  const next: CandidateMeta = {
    ...baseMeta(ctx, snap, version, candidateSha),
    amendment: meta.amendment + 1,
    previousCandidateSha: pr.headRefOid,
    supersedes: version === want ? meta.supersedes : pr.number,
  };
  const body = renderCandidateBody(next, snap.included, excludedSince(ctx, sourceSha), ctx.repo);
  const voided =
    `Amended by an explicit operator request: candidate \`${pr.headRefOid}\` → \`${candidateSha}\` (captured \`${ctx.sourceBranch}\` ` +
    `\`${meta.sourceSha.slice(0, 12)}\` → \`${sourceSha.slice(0, 12)}\`). Every check result and approval on the old SHA is void; ` +
    'CI re-runs on the new head and the aggregate needs a fresh review.';

  if (ctx.dryRun) {
    console.log(`DRY RUN: would amend #${pr.number} to ${candidateSha} as v${version}.\n\n${body}`);
    output({ status: 'dry-run', version, branch: candidateBranch(version), source_sha: sourceSha, candidate_sha: candidateSha, pr_number: pr.number });
    return 0;
  }

  if (version !== want) {
    // The new range needs a different version (a feat arrived, or a hotfix took
    // the old number). The branch name IS the version, so this is a new
    // candidate that supersedes the old one; the old branch is kept.
    assertVersionFree(ctx, version, open, pr.number);
    if (!pushCreate(ctx, candidateSha, next.branch)) throw new Refusal(`${next.branch} already exists; refusing to overwrite it`);
    const code = publish(ctx, next, body, pr.number);
    if (code !== 0) return code;
    gh(ctx, ['pr', 'close', String(pr.number), '--repo', ctx.repo, '--comment', `${voided}\n\nThe amended range needs v${version}, so it continues as ${next.branch}; this candidate is superseded. Its branch is kept.`]);
    return 0;
  }

  // Same version: move the branch, but only from the exact head we inspected.
  const lease = `--force-with-lease=refs/heads/${pr.headRefName}:${pr.headRefOid}`;
  if (!gitOk(ctx.cwd, 'push', '--quiet', lease, ctx.remote, `${candidateSha}:refs/heads/${pr.headRefName}`)) {
    throw new Refusal(`${pr.headRefName} moved while amending; nothing was changed. Re-run the amendment.`);
  }
  patchBody(ctx, pr.number, body);
  const dismissFailed = dismissApprovals(ctx, pr.number, voided);
  gh(ctx, ['pr', 'comment', String(pr.number), '--repo', ctx.repo, '--body', voided]);
  output({ status: 'amended', version, branch: pr.headRefName, source_sha: sourceSha, candidate_sha: candidateSha, pr_number: pr.number });
  if (dismissFailed) {
    console.log(`::error::Could not dismiss ${dismissFailed} approval(s) on #${pr.number}; dismiss them by hand. They no longer describe the candidate.`);
    return 1;
  }
  return 0;
}

/** Returns the number of approvals that could NOT be dismissed. */
function dismissApprovals(ctx: Ctx, number: number, message: string): number {
  const reviews = JSON.parse(gh(ctx, ['api', `repos/${ctx.repo}/pulls/${number}/reviews?per_page=100`]) || '[]') as Array<{ id: number; state: string }>;
  let failed = 0;
  for (const r of reviews.filter((x) => x.state === 'APPROVED')) {
    const res = sh(ctx.cwd, 'gh', ['api', '--method', 'PUT', `repos/${ctx.repo}/pulls/${number}/reviews/${r.id}/dismissals`, '-f', `message=${message}`, '-f', 'event=DISMISS']);
    if (res.status !== 0) failed++;
  }
  return failed;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function need(args: string[], name: string): string {
  const v = flag(args, name);
  if (v === undefined || v === '') throw new Refusal(`missing ${name}`);
  return v;
}

function context(args: string[]): Ctx {
  const cwd = process.cwd();
  let repo = flag(args, '--repo') || process.env.GITHUB_REPOSITORY || '';
  const dryRun = args.includes('--dry-run');
  if (!repo) {
    const r = sh(cwd, 'gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    repo = r.status === 0 ? r.stdout : '';
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Refusal(`cannot determine the GitHub repo (got "${repo}"); pass --repo owner/name`);
  const today = flag(args, '--today') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Refusal(`--today must be YYYY-MM-DD`);
  return {
    cwd,
    repo,
    remote: flag(args, '--remote') ?? 'origin',
    sourceBranch: flag(args, '--source-branch') ?? 'dev',
    baseBranch: flag(args, '--base-branch') ?? 'main',
    packageFiles: (flag(args, '--package-files') ?? DEFAULT_PACKAGE_FILES).split(/\s+/).filter(Boolean),
    versionFile: flag(args, '--version-file') ?? 'apps/web/package.json',
    today,
    dryRun,
  };
}

export function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'reconcile-changelog') {
      const read = (n: string) => readFileSync(need(args, n), 'utf8');
      process.stdout.write(reconcileChangelog(read('--base'), read('--ours'), read('--theirs')));
      return 0;
    }
    if (cmd === 'cut') {
      const ctx = context(args);
      return cut(ctx, need(args, '--source'), args.includes('--force'));
    }
    if (cmd === 'amend') {
      const ctx = context(args);
      return amend(ctx, need(args, '--candidate'), need(args, '--confirm'), need(args, '--source'));
    }
    console.error('usage: release-candidate.ts cut|amend|reconcile-changelog ...');
    return 2;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof Refusal) {
      console.log(`::error title=Release candidate refused::${msg}`);
      output({ status: 'refused' });
    } else {
      console.log(`::error::${msg}`);
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
