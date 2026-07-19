#!/usr/bin/env bun
/**
 * Spec hygiene linter + index generator.
 *
 * Keeps docs/specs/ clean: every capability spec must carry lifecycle
 * frontmatter, its `Code surface:` paths must resolve, superseded specs must
 * name a successor, and no two ACTIVE specs may claim the same slug (dup guard).
 * Also regenerates docs/specs/INDEX.md so the live/retired split is always
 * visible at a glance.
 *
 * Exit codes:
 *   0  clean (warnings allowed)
 *   1  one or more errors (missing frontmatter, dead code-surface path,
 *      duplicate active slug, superseded-without-successor)
 *
 * Usage:
 *   bun run scripts/check-specs.ts            # lint + rewrite INDEX.md
 *   bun run scripts/check-specs.ts --check    # lint only; fail if INDEX.md stale
 *
 * Specs live in docs/specs/. SPEC-FORMAT.md, REPORT.md, and INDEX.md are meta
 * files and are skipped by the frontmatter checks.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SPECS_DIR = join(ROOT, 'docs/specs');
const INDEX_FILE = join(SPECS_DIR, 'INDEX.md');

// Meta files that live in docs/specs/ but are not capability specs.
const META_FILES = new Set(['SPEC-FORMAT.md', 'REPORT.md', 'INDEX.md']);

const VALID_STATUS = new Set(['active', 'draft', 'superseded']);
const STALE_DAYS = 90;

const checkOnly = process.argv.includes('--check');

// ─── Minimal frontmatter parser ──────────────────────────────────────────────
// Specs use a flat YAML block: string scalars, ISO dates, and one-line arrays
// (`supersedes: [a, b]`). No nesting — a full YAML dep would be overkill.

interface Frontmatter {
  title?: string;
  status?: string;
  owner?: string;
  last_verified?: string;
  supersedes?: string[];
  superseded_by?: string;
}

function parseFrontmatter(raw: string): { fm: Frontmatter | null; body: string } {
  if (!raw.startsWith('---')) return { fm: null, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { fm: null, body: raw };
  const block = raw.slice(3, end).trim();
  const body = raw.slice(end + 4);
  const fm: Record<string, unknown> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { fm: fm as Frontmatter, body };
}

// ─── Load specs ──────────────────────────────────────────────────────────────

interface SpecFile {
  file: string;
  slug: string;
  fm: Frontmatter;
  body: string;
  errors: string[];
  warnings: string[];
}

function daysSince(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

// Pull file paths out of the `Code surface:` section so we can confirm they
// still exist (SPEC-FORMAT rule #4, previously unenforced).
function codeSurfacePaths(body: string): string[] {
  const start = body.search(/\*\*Code surface\*\*|Code surface:/i);
  if (start === -1) return [];
  const section = body.slice(start).split(/\n\*\*|\n## /)[0];
  const paths = new Set<string>();
  for (const m of section.matchAll(/`([^`]+)`/g)) {
    const token = m[1].split(/[\s:#]/)[0]; // strip `:symbol` / line refs
    if (/^(apps|packages|docs|scripts)\//.test(token)) paths.add(token);
  }
  return [...paths];
}

function loadSpecs(): SpecFile[] {
  const files = readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith('.md') && !META_FILES.has(f))
    .sort();

  return files.map((file) => {
    const raw = readFileSync(join(SPECS_DIR, file), 'utf8');
    const { fm, body } = parseFrontmatter(raw);
    const errors: string[] = [];
    const warnings: string[] = [];
    const slug = file.replace(/\.md$/, '');

    if (!fm) {
      errors.push('missing frontmatter block (--- ... ---)');
      return { file, slug, fm: {}, body, errors, warnings };
    }

    if (!fm.title) errors.push('frontmatter missing `title`');
    if (!fm.status) errors.push('frontmatter missing `status`');
    else if (!VALID_STATUS.has(fm.status))
      errors.push(`invalid status "${fm.status}" (active | draft | superseded)`);
    if (!fm.owner) errors.push('frontmatter missing `owner`');

    if (!fm.last_verified) {
      warnings.push('frontmatter missing `last_verified`');
    } else {
      const age = daysSince(fm.last_verified);
      if (age === null) errors.push(`last_verified "${fm.last_verified}" is not a valid date`);
      else if (age > STALE_DAYS)
        warnings.push(`last_verified is ${age}d old (>${STALE_DAYS}d) — re-verify against code`);
    }

    if (fm.status === 'superseded' && !fm.superseded_by)
      errors.push('status is `superseded` but no `superseded_by` successor named');

    for (const p of codeSurfacePaths(body)) {
      // Globs/placeholders (`00XX_*.sql`) can't be existence-checked — warn so the
      // author fills in the real path, but don't hard-fail CI on a template token.
      if (/[*]|\bXX\b|\bNN\b|X{2,}/i.test(p)) {
        warnings.push(`code surface path is an unresolved placeholder: ${p}`);
      } else if (!existsSync(join(ROOT, p))) {
        errors.push(`code surface path does not exist: ${p}`);
      }
    }

    return { file, slug, fm, body, errors, warnings };
  });
}

// ─── Cross-file checks ───────────────────────────────────────────────────────

function crossChecks(specs: SpecFile[]): string[] {
  const errors: string[] = [];

  // Dup guard: no two ACTIVE specs may share a slug-ish title.
  const byTitle = new Map<string, string[]>();
  for (const s of specs) {
    if (s.fm.status !== 'active' || !s.fm.title) continue;
    const key = s.fm.title.toLowerCase().trim();
    byTitle.set(key, [...(byTitle.get(key) ?? []), s.file]);
  }
  for (const [title, files] of byTitle) {
    if (files.length > 1)
      errors.push(`duplicate active title "${title}" in: ${files.join(', ')}`);
  }

  // Referential integrity: supersedes / superseded_by must point at real slugs.
  const slugs = new Set(specs.map((s) => s.slug));
  for (const s of specs) {
    for (const ref of s.fm.supersedes ?? [])
      if (!slugs.has(ref)) errors.push(`${s.file}: supersedes unknown spec "${ref}"`);
    if (s.fm.superseded_by && !slugs.has(s.fm.superseded_by))
      errors.push(`${s.file}: superseded_by unknown spec "${s.fm.superseded_by}"`);
  }

  return errors;
}

// ─── Index generation ────────────────────────────────────────────────────────

function buildIndex(specs: SpecFile[]): string {
  const line = (s: SpecFile) => {
    const title = s.fm.title ?? s.slug;
    const verified = s.fm.last_verified ? ` — verified ${s.fm.last_verified}` : '';
    const owner = s.fm.owner ? ` · @${s.fm.owner}` : '';
    return `- [${title}](./${s.file})${owner}${verified}`;
  };
  const group = (status: string) => specs.filter((s) => s.fm.status === status);

  const active = group('active');
  const draft = group('draft');
  const superseded = group('superseded');

  const out: string[] = [
    '<!-- GENERATED by scripts/check-specs.ts — do not edit by hand. -->',
    '# Spec Index',
    '',
    'Living capability contracts for buildd. Format: [SPEC-FORMAT.md](./SPEC-FORMAT.md).',
    'Canonical source of truth is [../SPEC.md](../SPEC.md); these are per-capability contracts.',
    '',
    `## Active (${active.length})`,
    '',
    ...(active.length ? active.map(line) : ['_none_']),
    '',
    `## Draft (${draft.length})`,
    '',
    ...(draft.length ? draft.map(line) : ['_none_']),
    '',
    `## Superseded (${superseded.length})`,
    '',
    ...(superseded.length
      ? superseded.map((s) => `${line(s)} → replaced by \`${s.fm.superseded_by ?? '?'}\``)
      : ['_none_']),
    '',
  ];
  return out.join('\n');
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const specs = loadSpecs();
const crossErrors = crossChecks(specs);

let errorCount = crossErrors.length;
let warnCount = 0;

for (const s of specs) {
  for (const e of s.errors) {
    console.error(`✖ ${s.file}: ${e}`);
    errorCount++;
  }
  for (const w of s.warnings) {
    console.warn(`⚠ ${s.file}: ${w}`);
    warnCount++;
  }
}
for (const e of crossErrors) console.error(`✖ ${e}`);

// INDEX.md handling
const nextIndex = buildIndex(specs);
const currentIndex = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : '';
if (checkOnly) {
  if (nextIndex.trim() !== currentIndex.trim()) {
    console.error('✖ docs/specs/INDEX.md is stale — run `bun run specs:check` to regenerate');
    errorCount++;
  }
} else if (nextIndex.trim() !== currentIndex.trim()) {
  writeFileSync(INDEX_FILE, nextIndex);
  console.log('✎ regenerated docs/specs/INDEX.md');
}

console.log(
  `\n${specs.length} specs · ${errorCount} error(s) · ${warnCount} warning(s)`,
);
process.exit(errorCount > 0 ? 1 : 0);
