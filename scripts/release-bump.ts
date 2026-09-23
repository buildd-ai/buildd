#!/usr/bin/env bun
/**
 * Semver bump-class helper shared by `release-refresh.yml` (keep an open release
 * PR's version honest as `dev` moves) and `release-tag.yml` (warn when a tag
 * under-bumps what it ships).
 *
 * Why it exists: a release PR's head is `dev`, so every merge after the cut lands
 * in it, but its title, package.json versions and CHANGELOG section are computed
 * once, at cut time. A `feat` merged after a patch cut ships as a patch, and Tag
 * Release tags it as one because it reads package.json.
 *
 * The bump rules are deliberately the ones `scripts/release.sh` (and the
 * reusable release workflow) already use, so a refresh can never pick a class
 * the cut itself would not have picked from the same commits:
 *   - `BREAKING CHANGE` / `BREAKING-CHANGE` anywhere, or `type!:` → major
 *   - `feat:` / `feat(scope):` → minor
 *   - anything else → patch
 *
 * CLI (commit subjects on stdin, one per line):
 *   plan      --latest-tag vX.Y.Z --current X.Y.Z          → JSON plan on stdout
 *   apply     --from X.Y.Z --to X.Y.Z [--package-files "a b"] → rewrites files in cwd
 *   check-tag --prev-tag vX.Y.Z --version vX.Y.Z            → ::warning:: annotation, always exit 0
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

export type BumpClass = 'patch' | 'minor' | 'major';

const RANK: Record<BumpClass, number> = { patch: 0, minor: 1, major: 2 };

const MAJOR_RE = /BREAKING[ -]CHANGE|^[a-z]+!:/i;
const MINOR_RE = /^feat(\(.+\))?:/;

export const DEFAULT_PACKAGE_FILES =
  'apps/runner/package.json apps/web/package.json packages/core/package.json packages/shared/package.json';

function classOf(subject: string): BumpClass {
  // release.sh: `grep -qiE 'BREAKING[ -]CHANGE|^[a-z]+!:'` (case-insensitive, both
  // alternatives), then `grep -qE '^feat(\(.+\))?:'` (case-sensitive).
  if (MAJOR_RE.test(subject)) return 'major';
  if (MINOR_RE.test(subject)) return 'minor';
  return 'patch';
}

export function bumpClass(subjects: string[]): BumpClass {
  let out: BumpClass = 'patch';
  for (const raw of subjects) {
    const s = raw.trim();
    if (!s) continue;
    const c = classOf(s);
    if (RANK[c] > RANK[out]) out = c;
    if (out === 'major') break;
  }
  return out;
}

function parts(v: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) throw new Error(`not a semver version: "${v}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function nextVersion(base: string, bump: BumpClass): string {
  const [maj, min, pat] = parts(base);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** Only the exact generated shape — a hand-edited title is left alone. */
export function parseReleaseTitle(title: string): string | null {
  const m = /^Release v(\d+\.\d+\.\d+)$/.exec(title.trim());
  return m ? m[1] : null;
}

export interface RefreshPlan {
  bump: BumpClass;
  /** What the commits since the latest tag demand. */
  required: string;
  /** What the PR should carry: `required`, unless someone already went higher. */
  target: string;
  /** True when `target` is above the version the PR carries now. */
  raise: boolean;
}

export function planRefresh(opts: { latestTag: string; currentVersion: string; subjects: string[] }): RefreshPlan {
  const bump = bumpClass(opts.subjects);
  const required = nextVersion(opts.latestTag || '0.0.0', bump);
  const raise = compareSemver(required, opts.currentVersion) > 0;
  return { bump, required, target: raise ? required : opts.currentVersion.replace(/^v/, ''), raise };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rename the promoted `## [from]` section and its two footer links to `to`.
 * Content with no `## [from]` section is returned unchanged (promotion is
 * skipped when [Unreleased] was empty at cut time).
 */
export function renameChangelogVersion(content: string, from: string, to: string): string {
  const f = escapeRe(from);
  const header = new RegExp(`^## \\[${f}\\]`, 'm');
  if (!header.test(content)) return content;
  return content
    .replace(header, `## [${to}]`)
    .replace(new RegExp(`^(\\[Unreleased\\]:.*compare/)v${f}(\\.\\.\\.HEAD)$`, 'm'), `$1v${to}$2`)
    .replace(new RegExp(`^\\[${f}\\]:(.*\\.\\.\\.)v${f}$`, 'm'), `[${to}]:$1v${to}`);
}

function shippedClass(prev: string, version: string): BumpClass {
  const [pM, pm] = parts(prev);
  const [vM, vm] = parts(version);
  if (vM > pM) return 'major';
  if (vM === pM && vm > pm) return 'minor';
  return 'patch';
}

/**
 * Tag-time check: does `version` increment `prevTag` by at least what the
 * shipped commits demand? Returns a human-readable warning, or null.
 */
export function tagSemverWarning(opts: { prevTag: string; version: string; subjects: string[] }): string | null {
  if (!opts.prevTag) return null;
  const required = bumpClass(opts.subjects);
  const shipped = shippedClass(opts.prevTag, opts.version);
  if (RANK[shipped] >= RANK[required]) return null;
  const culprits = opts.subjects
    .map((s) => s.trim())
    .filter((s) => s && RANK[classOf(s)] > RANK[shipped])
    .slice(0, 5);
  return (
    `${opts.version} was tagged as a ${shipped} bump over ${opts.prevTag}, but the commits it ships need a ${required} bump ` +
    `(${culprits.join('; ')}). The tag stays; the next release will not correct it. ` +
    `If consumers depend on semver, cut the next release as a ${required} bump.`
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function required(args: string[], name: string): string {
  const v = flag(args, name);
  if (v === undefined) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

function readStdinLines(): string[] {
  try {
    return readFileSync(0, 'utf8').split('\n');
  } catch {
    return [];
  }
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  if (cmd === 'plan') {
    const plan = planRefresh({
      latestTag: required(args, '--latest-tag'),
      currentVersion: required(args, '--current'),
      subjects: readStdinLines(),
    });
    console.log(JSON.stringify(plan));
    return 0;
  }
  if (cmd === 'apply') {
    const from = required(args, '--from').replace(/^v/, '');
    const to = required(args, '--to').replace(/^v/, '');
    const files = (flag(args, '--package-files') ?? DEFAULT_PACKAGE_FILES).split(/\s+/).filter(Boolean);
    // Validate everything before writing anything: a half-bumped tree is worse
    // than no bump, because Tag Release reads one of these files.
    const loaded: Array<{ file: string; json: Record<string, unknown>; indent: string }> = [];
    for (const file of files) {
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf8');
      const json = JSON.parse(raw);
      if (json.version !== from) {
        console.error(`${file} is at ${json.version}, expected ${from} — refusing to bump`);
        return 1;
      }
      const indent = /^\{\n([ \t]+)/.exec(raw)?.[1] ?? '  ';
      loaded.push({ file, json, indent });
    }
    if (loaded.length === 0) {
      console.error(`none of the package files exist: ${files.join(', ')}`);
      return 1;
    }
    for (const { file, json, indent } of loaded) {
      json.version = to;
      writeFileSync(file, JSON.stringify(json, null, indent) + '\n');
      console.log(`  ${file} → ${to}`);
    }
    if (existsSync('CHANGELOG.md')) {
      const before = readFileSync('CHANGELOG.md', 'utf8');
      const after = renameChangelogVersion(before, from, to);
      if (after !== before) {
        writeFileSync('CHANGELOG.md', after);
        console.log(`  CHANGELOG.md [${from}] → [${to}]`);
      }
    }
    return 0;
  }
  if (cmd === 'check-tag') {
    const warning = tagSemverWarning({
      prevTag: flag(args, '--prev-tag') ?? '',
      version: required(args, '--version'),
      subjects: readStdinLines(),
    });
    if (warning) console.log(`::warning title=Semver under-bump::${warning}`);
    else console.log('Semver increment matches the shipped commits.');
    return 0;
  }
  console.error('usage: release-bump.ts plan|apply|check-tag ...');
  return 2;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
