/**
 * Importing a repo spec file as a native spec (docs/specs/living-specs.md §18,
 * R-18, R-20). Pure: given a file's path and text, what the import would make
 * of it, or why it is skipped.
 *
 * The imported body is the file as read minus its frontmatter block: the
 * mechanical fields (R-14: `status`, `owner`, `last_verified`, `domain`,
 * `surfaces`, `verified_by`, `assertions`) and the `summary` become the
 * metadata block, the `title` the spec's title, and everything after the
 * frontmatter stays byte for byte. YAML comments in the frontmatter (such as
 * `# Structural conformance only...`) go with it, so they never read as the
 * body's first heading. A confirmed import's generated copy (repo-copy.ts)
 * writes the title, summary and metadata block back as its frontmatter.
 *
 * The import also says which criterion-like ids the body defines that the
 * parser does not read (AC-3a, AC-AQR-1, INV-2) and which it defines more than
 * once, and records them on the metadata (`criteria_unread`). It never refuses
 * a file for them.
 *
 * Skipped, never imported: the format and the generated index (SPEC-FORMAT.md,
 * INDEX.md and the other meta files, R-20), a superseded spec, and a file that
 * is already a generated copy of a native spec (it carries `generated_from`).
 */
import type { AssertionValue, SpecMetadata } from './repo-copy';
import { GENERATED_FIELDS, METADATA_FIELDS } from './repo-copy';
import { parseSpecFrontmatter, SPEC_META_FILES } from './repo-spec';
import { criterionIdProblems, type CriterionIdProblems } from './requirements';

/** Frontmatter keys an import moves out of the body: the metadata fields and `owner`. */
export const IMPORT_MECHANICAL_FIELDS: readonly string[] = [...METADATA_FIELDS, 'owner'];

export type ImportSkipReason = 'meta_file' | 'not_a_spec_file' | 'superseded' | 'generated_copy' | 'no_title';

export type RepoSpecImport =
  | {
    ok: true;
    title: string;
    /** The file minus its mechanical frontmatter: what revision 1 holds. */
    body: string;
    /** The mechanical fields, as the metadata block takes them. */
    metadata: SpecMetadata;
    /** The `domain:` value, the hint the spec is filed by. */
    domain: string | null;
    /** The file's `status:` as written (draft, active), for the report only. */
    status: string | null;
    /** Mechanical values that could not be read, by field; the rest import. */
    unread: string[];
    /** Criterion ids the body defines that the parser does not read, and ids it defines twice. */
    criteria: CriterionIdProblems;
  }
  | { ok: false; reason: ImportSkipReason; message: string };

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/;

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t;
};

function scalarValue(raw: string): AssertionValue {
  const t = raw.trim();
  if (/^(true|false)$/.test(t)) return t === 'true';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return unquote(t);
}

function listValue(raw: string): string[] | null {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  return t.slice(1, -1).split(',').map((s) => unquote(s)).filter(Boolean);
}

/** The `assertions:` block's continuation lines as flat objects; null when they are not that shape. */
function assertionsValue(lines: readonly string[]): Array<Record<string, AssertionValue>> | null {
  const out: Array<Record<string, AssertionValue>> = [];
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue; // YAML comments carry nothing the block keeps
    const item = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    const field = /^\s+([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (item) out.push({ [item[1]!]: scalarValue(item[2]!) });
    else if (field && out.length) out[out.length - 1]![field[1]!] = scalarValue(field[2]!);
    else return null;
  }
  return out;
}

/**
 * Split a frontmatter's inner lines into what stays (intent) and the mechanical
 * fields, each with its continuation lines (an indented block like `assertions:`).
 */
function splitFrontmatter(inner: string): { kept: string[]; mechanical: Map<string, { value: string; block: string[] }> } {
  const lines = inner.split('\n');
  const kept: string[] = [];
  const mechanical = new Map<string, { value: string; block: string[] }>();
  let current: { key: string; drop: boolean } | null = null;
  for (const line of lines) {
    const m = KEY_LINE.exec(line);
    if (m) {
      const key = m[1]!;
      const drop = IMPORT_MECHANICAL_FIELDS.includes(key) || (GENERATED_FIELDS as readonly string[]).includes(key);
      current = { key, drop };
      if (drop) mechanical.set(key, { value: m[2]!.trim(), block: [] });
      else kept.push(line);
      continue;
    }
    // A continuation (indented, a list item) belongs to the key above it.
    if (current?.drop && (/^\s/.test(line) || line.startsWith('- '))) {
      mechanical.get(current.key)!.block.push(line);
      continue;
    }
    if (!/^\s/.test(line) && !line.startsWith('- ')) current = null;
    kept.push(line);
  }
  return { kept, mechanical };
}

/** What importing one repo spec file would make, or why it is skipped. `path` is repo-relative. */
export function repoSpecForImport(path: string, text: string): RepoSpecImport {
  const name = path.split('/').pop() ?? path;
  if (!/^docs\/specs\/[^/]+\.md$/.test(path)) return { ok: false, reason: 'not_a_spec_file', message: `${path} is not a spec file under docs/specs` };
  if (SPEC_META_FILES.has(name)) {
    return { ok: false, reason: 'meta_file', message: name === 'INDEX.md' ? 'INDEX.md is generated by specs:check, not a spec' : `${name} describes the spec format and stays in the repo` };
  }
  const { fm } = parseSpecFrontmatter(text);
  const normalized = text.replace(/\r\n/g, '\n');
  const open = normalized.startsWith('---\n');
  const close = open ? normalized.indexOf('\n---\n', 3) : -1;
  const closeAtEnd = open && close === -1 && normalized.endsWith('\n---');
  const hasFm = open && (close !== -1 || closeAtEnd);
  const inner = hasFm ? normalized.slice(4, close === -1 ? normalized.length - 4 : close) : '';
  const rest = hasFm ? (close === -1 ? '' : normalized.slice(close + 5)) : normalized;
  const { mechanical } = hasFm ? splitFrontmatter(inner) : { mechanical: new Map<string, { value: string; block: string[] }>() };

  if (mechanical.has('generated_from')) return { ok: false, reason: 'generated_copy', message: `${path} is a generated copy of a native spec; it is edited in buildd already` };
  const status = fm?.status ? String(fm.status) : null;
  if (status === 'superseded') return { ok: false, reason: 'superseded', message: `${path} is superseded${fm?.superseded_by ? ` by ${fm.superseded_by}` : ''}` };

  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(rest)?.[1];
  const title = (typeof fm?.title === 'string' && fm.title.trim()) || heading?.trim() || '';
  if (!title) return { ok: false, reason: 'no_title', message: `${path} has no title (no \`title:\` and no top heading)` };

  const metadata: SpecMetadata = {};
  const unread: string[] = [];
  for (const [key, { value, block }] of mechanical) {
    switch (key) {
      case 'owner': if (value) metadata.owner = unquote(value); break;
      case 'last_verified': if (value) metadata.last_verified = unquote(value); break;
      case 'surfaces':
      case 'verified_by': {
        const list = listValue(value);
        if (list === null) { if (value || block.length) unread.push(key); break; }
        if (list.length) metadata[key] = list;
        break;
      }
      case 'assertions': {
        if (value && value !== '[]') { unread.push(key); break; }
        const a = assertionsValue(block);
        if (a === null) unread.push(key);
        else if (a.length) metadata.assertions = a;
        break;
      }
      default: break; // status and domain: derived on generation, reported only.
    }
  }

  // The summary is the one intent field the metadata block carries; the title is the spec's own.
  const summary = typeof fm?.summary === 'string' ? fm.summary.replace(/\s+/g, ' ').trim() : '';
  if (summary) metadata.summary = summary;

  // The body is what follows the frontmatter; the block itself is in the title and metadata now.
  const body = rest.replace(/^\n+/, '');
  const criteria = criterionIdProblems(body);
  if (criteria.unreadable.length || criteria.duplicates.length) metadata.criteria_unread = criteria;
  const domain = mechanical.get('domain')?.value ? unquote(mechanical.get('domain')!.value).toLowerCase() : null;
  return { ok: true, title: title.slice(0, 200), body, metadata, domain: domain || null, status, unread, criteria };
}
