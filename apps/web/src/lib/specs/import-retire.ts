import { parseSpecFrontmatter } from '@buildd/spec-contract/repo-spec';

/**
 * Which imported specs an import run offers to retire (living-specs §22,
 * R-79): a live spec whose file is gone, or whose file now says
 * `status: superseded`. A plan only: it writes nothing, and only the entries a
 * person confirms are retired (./import.ts confirmImportedSpecs).
 */

export interface ImportRetirement {
  action: 'retire';
  specId: string;
  path: string;
  why: 'removed' | 'marked_superseded';
  /** The spec that replaces it, when buildd matched the file's `superseded_by`; null retires it. */
  supersededBy: string | null;
  /** "file removed in <commit>" or "marked superseded by <name>". */
  reason: string;
}

const GONE = new Set(['retired', 'superseded']);

/**
 * `files`: docs/specs at `commit`. `titles`: a `superseded_by` value to the
 * spec it names, as buildd matched it. `removedIn`: the commit that removed a
 * path, when known; else `commit`. `names`: a `superseded_by` value to the
 * replacement's title, for the reason.
 */
export function planImportRetirements(input: {
  imported: ReadonlyArray<{ specId: string; title: string; path: string; status: string }>;
  files: ReadonlyArray<{ path: string; text: string }>;
  commit: string;
  titles: Readonly<Record<string, string>>;
  removedIn?: Readonly<Record<string, string | null | undefined>>;
  names?: Readonly<Record<string, string>>;
}): ImportRetirement[] {
  const byPath = new Map(input.files.map((f) => [f.path, f.text]));
  const out: ImportRetirement[] = [];
  for (const s of input.imported) {
    if (GONE.has(s.status)) continue;
    const text = byPath.get(s.path);
    if (text === undefined) {
      const sha = input.removedIn?.[s.path] ?? input.commit;
      out.push({ action: 'retire', specId: s.specId, path: s.path, why: 'removed', supersededBy: null, reason: `file removed in ${sha.slice(0, 7)}` });
      continue;
    }
    const fm = parseSpecFrontmatter(text).fm;
    if (fm?.status !== 'superseded') continue;
    const named = typeof fm.superseded_by === 'string' ? fm.superseded_by : '';
    const by = named && named !== 'none' ? input.titles[named] ?? null : null;
    const label = by ? input.names?.[named] ?? named : named && named !== 'none' ? named : '';
    out.push({ action: 'retire', specId: s.specId, path: s.path, why: 'marked_superseded', supersededBy: by, reason: label ? `marked superseded by ${label}` : 'marked superseded, with nothing replacing it' });
  }
  return out;
}

/** The plan entries a person confirmed: nothing is retired without that. */
export function confirmedRetirements(plan: readonly ImportRetirement[], confirmedSpecIds: readonly string[]): ImportRetirement[] {
  const ids = new Set(confirmedSpecIds);
  return plan.filter((p) => ids.has(p.specId));
}
