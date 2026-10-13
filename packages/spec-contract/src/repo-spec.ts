/**
 * The repo spec format's pure rules (docs/specs/SPEC-FORMAT.md): the flat
 * frontmatter parser, the per-file frontmatter lint, the `Code surface` path
 * extractor and the INDEX.md builder. `scripts/check-specs.ts` (`specs:lint`)
 * runs them over the checkout; buildd runs the same functions over a generated
 * repo copy before approval and when it writes the copy's PR (living-specs.md
 * §18, R-34), so the preflight is the lint, not a port of it.
 *
 * File access is injected (`exists`), so nothing here touches a filesystem.
 */

export interface SpecFrontmatter {
  title?: string;
  status?: string;
  owner?: string;
  last_verified?: string;
  /** One-sentence capability statement — what MUST hold. Required. */
  summary?: string;
  /** Controlled vocabulary, see DOMAINS in scripts/check-specs.ts. Required. */
  domain?: string;
  /** Primary implementation paths — the 2-4 files to open first. */
  surfaces?: string[];
  /** Sibling spec slugs. Validated: a dead reference is an error. */
  related?: string[];
  /** Retrieval aliases — terms a reader would search that the title omits. */
  keywords?: string[];
  /**
   * Test files that actually assert this spec's invariants. Required for
   * `status: active` — a contract nobody can fail is a wish, not a contract.
   */
  verified_by?: string[];
  supersedes?: string[];
  superseded_by?: string;
}

/** One spec file as the index and the cross checks read it. */
export interface IndexedSpec {
  file: string;
  slug: string;
  fm: SpecFrontmatter;
}

export const VALID_SPEC_STATUS = new Set(['active', 'draft', 'superseded']);
export const STALE_DAYS = 90;
/** Longer than this and it is not a summary; it is the spec. */
export const SUMMARY_MAX = 220;

// Specs use a flat YAML block: string scalars, ISO dates, and one-line arrays
// (`supersedes: [a, b]`). No nesting — a full YAML dep would be overkill.
export function parseSpecFrontmatter(raw: string): { fm: SpecFrontmatter | null; body: string } {
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
    const val = rawVal!.trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key!] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      fm[key!] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { fm: fm as SpecFrontmatter, body };
}

function daysSince(iso: string, now: number): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

// Pull file paths out of the `Code surface:` section so we can confirm they
// still exist (SPEC-FORMAT rule #4, previously unenforced).
export function codeSurfacePaths(body: string): string[] {
  // Three spellings occur in the wild: `**Code surface**:`, `Code surface:`, and a
  // `## Code surface` heading. Missing the heading form meant one spec's dead path
  // sat unnoticed — the check silently found zero paths and passed.
  //
  // EVERY occurrence, not just the first. A multi-section spec repeats the label
  // once per section, and reading only the first match left sections 2..N entirely
  // unchecked: work-tracker-integration.md carries three, and its §3 named a route
  // that does not exist while this check reported zero errors.
  const paths = new Set<string>();
  for (const label of body.matchAll(/\*\*Code surface\*\*|^#{2,4} Code surface|Code surface:/gim)) {
    // Stop at the next bold label or heading, but not on the heading we just matched.
    const rest = body.slice(label.index);
    const section = rest.slice(0, 1) + rest.slice(1).split(/\n\*\*|\n#{2,4} /)[0];
    for (const m of section.matchAll(/`([^`]+)`/g)) {
      const token = m[1]!.split(/[\s:#]/)[0]!; // strip `:symbol` / line refs
      if (/^(apps|packages|docs|scripts)\//.test(token)) paths.add(token);
    }
  }
  return [...paths];
}

export interface FrontmatterLintOptions {
  /** The allowed `domain` values. */
  domains: ReadonlySet<string>;
  /** Whether a repo-relative path exists. */
  exists: (path: string) => boolean;
  /** Active specs allowed to have no `verified_by` (pre-existing debt). */
  verifiedByDebt?: ReadonlySet<string>;
  now?: number;
}

/** The per-file checks `specs:lint` runs on one spec: frontmatter, then its code-surface paths. */
export function lintSpecFile(slug: string, fm: SpecFrontmatter | null, body: string, opts: FrontmatterLintOptions): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!fm) {
    errors.push('missing frontmatter block (--- ... ---)');
    return { errors, warnings };
  }
  const { domains, exists } = opts;
  const debt = opts.verifiedByDebt ?? new Set<string>();

  if (!fm.title) errors.push('frontmatter missing `title`');
  if (!fm.status) errors.push('frontmatter missing `status`');
  else if (!VALID_SPEC_STATUS.has(fm.status))
    errors.push(`invalid status "${fm.status}" (active | draft | superseded)`);
  if (!fm.owner) errors.push('frontmatter missing `owner`');

  if (!fm.last_verified) {
    warnings.push('frontmatter missing `last_verified`');
  } else {
    const age = daysSince(fm.last_verified, opts.now ?? Date.now());
    if (age === null) errors.push(`last_verified "${fm.last_verified}" is not a valid date`);
    else if (age > STALE_DAYS)
      warnings.push(`last_verified is ${age}d old (>${STALE_DAYS}d) — re-verify against code`);
  }

  if (fm.status === 'superseded' && !fm.superseded_by)
    errors.push('status is `superseded` but no `superseded_by` successor named');

  // ── Ingestion fields ──────────────────────────────────────────────────────
  // A spec that cannot be summarised in one line and filed under one domain is
  // not readable by a person skimming the index, and not retrievable by an
  // agent that has to pick one spec out of twenty.
  if (!fm.summary) {
    errors.push('frontmatter missing `summary` (one sentence: what MUST hold)');
  } else if (Array.isArray(fm.summary)) {
    // The parser coerces any `[...]` value to an array. Without this branch the
    // presence check passes, the length check silently measures item count, and
    // INDEX.md renders the comma-joined array as the summary.
    errors.push('`summary` must be a single sentence, not a list — it must not start with `[`');
  } else if (fm.summary.length > SUMMARY_MAX) {
    warnings.push(`summary is ${fm.summary.length} chars (>${SUMMARY_MAX}) — compress it`);
  }

  if (!fm.domain) {
    errors.push(`frontmatter missing \`domain\` (one of: ${[...domains].join(', ')})`);
  } else if (!domains.has(fm.domain)) {
    errors.push(`invalid domain "${fm.domain}" (one of: ${[...domains].join(', ')})`);
  }

  if (fm.surfaces && fm.surfaces.length > 4) {
    warnings.push(`surfaces lists ${fm.surfaces.length} paths (>4) — it is a shortlist, not the full Code surface section`);
  }
  for (const p of fm.surfaces ?? []) {
    if (!exists(p)) errors.push(`surfaces path does not exist: ${p}`);
  }

  // ── verified_by: the spec's invariants must be machine-checkable ──────────
  const guards = fm.verified_by ?? [];
  if (fm.status === 'active' && guards.length === 0) {
    if (debt.has(slug)) {
      warnings.push(`no \`verified_by\` — pre-existing debt, ${debt.size} spec(s) still owe guards`);
    } else {
      errors.push('status is `active` but `verified_by` is empty — name the tests that assert these invariants, or set `status: draft`');
    }
  }
  for (const p of guards) {
    if (!exists(p)) errors.push(`verified_by path does not exist: ${p}`);
    else if (!/\.test\.(ts|tsx)$/.test(p) && !p.includes('__tests__'))
      warnings.push(`verified_by path is not a test file: ${p}`);
  }

  for (const p of codeSurfacePaths(body)) {
    // Globs/placeholders (`00XX_*.sql`) can't be existence-checked — warn so the
    // author fills in the real path, but don't hard-fail CI on a template token.
    if (/[*]|\bXX\b|\bNN\b|X{2,}/i.test(p)) {
      warnings.push(`code surface path is an unresolved placeholder: ${p}`);
    } else if (!exists(p)) {
      errors.push(`code surface path does not exist: ${p}`);
    }
  }
  return { errors, warnings };
}

/** Cross-file checks: duplicate active titles and dangling slugs. */
export function crossCheckSpecs(specs: readonly IndexedSpec[]): string[] {
  const errors: string[] = [];

  // Dup guard: no two ACTIVE specs may share a title (compared lowercased/trimmed).
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
    for (const ref of s.fm.related ?? []) {
      if (ref === s.slug) errors.push(`${s.file}: related lists itself`);
      else if (!slugs.has(ref)) errors.push(`${s.file}: related unknown spec "${ref}"`);
    }
  }

  return errors;
}

/** docs/specs/INDEX.md for a set of spec files (in file order). */
export function buildSpecIndex(specs: readonly IndexedSpec[]): string {
  const line = (s: IndexedSpec) => {
    const title = s.fm.title ?? s.slug;
    const verified = s.fm.last_verified ? ` — verified ${s.fm.last_verified}` : '';
    const owner = s.fm.owner ? ` · @${s.fm.owner}` : '';
    const summary = s.fm.summary ? `\n  ${s.fm.summary}` : '';
    return `- [${title}](./${s.file})${owner}${verified}${summary}`;
  };
  const group = (status: string) => specs.filter((s) => s.fm.status === status);

  /** Active specs, grouped by domain, so the index reads as a map of the system. */
  const byDomain = (items: IndexedSpec[]): string[] => {
    const domains = [...new Set(items.map((s) => s.fm.domain ?? 'unfiled'))].sort();
    const out: string[] = [];
    for (const d of domains) {
      const inDomain = items.filter((s) => (s.fm.domain ?? 'unfiled') === d);
      out.push(`### ${d} (${inDomain.length})`, '', ...inDomain.map(line), '');
    }
    return out;
  };

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
    ...(active.length ? byDomain(active) : ['_none_', '']),
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

/** Meta files in docs/specs that are not capability specs. */
export const SPEC_META_FILES = new Set(['SPEC-FORMAT.md', 'REPORT.md', 'INDEX.md']);

/**
 * The domain vocabulary as `scripts/check-specs.ts` declares it (`const DOMAINS =
 * new Set([...])`), read from the script's text; null when the shape is not found.
 */
export function readDomainList(checkSpecsSource: string): string[] | null {
  const m = /const DOMAINS = new Set\(\[([\s\S]*?)\]\);/.exec(checkSpecsSource);
  if (!m) return null;
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The script's text with `value` added to DOMAINS (unchanged when present); null when the list is not found. */
export function withDomain(checkSpecsSource: string, value: string): string | null {
  const list = readDomainList(checkSpecsSource);
  if (!list) return null;
  if (list.includes(value)) return checkSpecsSource;
  if (!/^[a-z][a-z0-9-]*$/.test(value)) return null;
  return checkSpecsSource.replace(/(const DOMAINS = new Set\(\[[\s\S]*?)(\n\]\);)/, (_all, head: string, tail: string) => `${head}\n  '${value}',${tail}`);
}
