/**
 * Guided spec authoring: a pure mapper from interview answers to one draft spec
 * file (docs/design/workspace-onboarding.md §4).
 *
 * No IO. The caller supplies the repo's file list and, when the spec root already
 * holds specs, the text of one or two of them to mirror. The output is one flat
 * markdown file at `<specsRoot>/<slug>.md`, always `status: draft`, in which every
 * claim about the repo (code surface, `verified_by`, assertions) is one that the
 * supplied file list verifies, and nothing else.
 */

import {
  MIN_ACCEPTANCE_CRITERIA_PER_BLOCK,
  rewriteModals,
  validateInterviewAnswers,
  type InterviewIssue,
  type SpecCapabilityAnswers,
  type SpecExample,
  type SpecInterviewAnswers,
} from '@buildd/shared';
import { detectSpecConformanceRoots } from './spec-conformance-detect';

/** The default format's spec directory (docs/specs/SPEC-FORMAT.md). */
export const DEFAULT_SPECS_ROOT = 'docs/specs';
const DEFAULT_DOMAIN = 'product';
const MAX_SLUG_CHARS = 60;
const MAX_SUMMARY_CHARS = 220;
const MAX_SURFACES = 4;

export interface SpecAuthoringInput {
  answers: SpecInterviewAnswers;
  /** Repo file paths on the default branch; `null` when the tree could not be read. */
  files: string[] | null;
  /** The tree was cut short, so an absent path may still exist. */
  truncated?: boolean;
  /** The configured or detected spec root, or null when the repo has none. */
  specsRoot: string | null;
  /** Text of up to two existing specs under the root; the first with frontmatter is mirrored. */
  mirrorSpecs?: string[];
  /** GitHub handle, no `@`. */
  owner: string;
  /** ISO date for `last_verified`. */
  today: string;
}

export interface SpecAuthoringSuccess {
  ok: true;
  path: string;
  slug: string;
  specsRoot: string;
  markdown: string;
  format: 'default' | 'mirrored';
  warnings: string[];
  dropped: { codePaths: string[]; verification: string[] };
  /** Q8: for the merge-policy owner decision. Never rendered in the spec. */
  mergePolicy: { paths: string[]; notes: string[] };
}

export interface SpecAuthoringFailure {
  ok: false;
  errors: InterviewIssue[];
  /** A file already exists at the target path. */
  conflict?: boolean;
}

export type SpecAuthoringResult = SpecAuthoringSuccess | SpecAuthoringFailure;

/** Configured root wins, then the same detection `init` and readiness use. */
export function resolveSpecsRoot(files: string[], configured?: string | null): string | null {
  const root = configured?.trim().replace(/\/+$/, '');
  return root || detectSpecConformanceRoots(files).specsRoot;
}

// --- format -----------------------------------------------------------------

type Section = 'capability' | 'invariants' | 'acceptance' | 'codeSurface' | 'outOfScope';

interface SpecFormat {
  source: 'default' | 'mirrored';
  /** Frontmatter keys in the order the mirrored spec uses them. */
  keyOrder: string[];
  style: 'bold' | 'heading';
  labels: Record<Section, string>;
}

const DEFAULT_LABELS: Record<Section, string> = {
  capability: 'Capability statement',
  invariants: 'Invariants',
  acceptance: 'Acceptance criteria',
  codeSurface: 'Code surface',
  outOfScope: 'Out of scope',
};

const SECTION_MATCH: Record<Section, RegExp> = {
  capability: /^capability( statement)?$/i,
  invariants: /^invariants?$/i,
  acceptance: /^acceptance criteria$/i,
  codeSurface: /^code surface$/i,
  outOfScope: /^out of scope$/i,
};

const REQUIRED_KEYS = ['title', 'status', 'owner', 'last_verified', 'summary', 'domain'] as const;
const KNOWN_KEYS = [...REQUIRED_KEYS, 'surfaces', 'verified_by', 'assertions'] as const;
const DEFAULT_KEY_ORDER = [...KNOWN_KEYS];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function inferFormat(mirrors: string[]): SpecFormat {
  const fallback: SpecFormat = { source: 'default', keyOrder: DEFAULT_KEY_ORDER, style: 'bold', labels: DEFAULT_LABELS };
  for (const text of mirrors) {
    const fm = FRONTMATTER.exec(text);
    if (!fm) continue;
    const keys = fm[1]
      .split(/\r?\n/)
      .map((l) => /^([A-Za-z_][\w-]*):/.exec(l)?.[1])
      .filter((k): k is string => !!k);
    if (keys.length === 0) continue;

    const body = text.slice(fm[0].length);
    let bold = 0;
    let heading = 0;
    const labels: Record<Section, string> = { ...DEFAULT_LABELS };
    for (const line of body.split(/\r?\n/)) {
      const b = /^\*\*(.+?)\*\*:?\s*(?::|$)/.exec(line) ?? /^\*\*(.+?):\*\*/.exec(line);
      const h = /^#{3,4}\s+(.+?)\s*$/.exec(line);
      const label = (b?.[1] ?? h?.[1])?.trim();
      if (!label) continue;
      for (const section of Object.keys(SECTION_MATCH) as Section[]) {
        if (!SECTION_MATCH[section].test(label)) continue;
        labels[section] = label;
        if (b) bold++;
        else heading++;
      }
    }
    return { source: 'mirrored', keyOrder: keys, style: heading > bold ? 'heading' : 'bold', labels };
  }
  return fallback;
}

// --- text helpers -----------------------------------------------------------

const upperFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string) => (s && !/^[A-Z]{2,}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, '');
}

function yamlScalar(value: string): string {
  const plain = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^]*$/.test(value) && !/[:#]\s|\s#|:$|\s$/.test(value);
  return plain ? value : JSON.stringify(value);
}

function firstSentence(text: string): string {
  const flat = oneLine(text);
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  return m ? m[1] : flat;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e)\//i;
const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$/i;
const isTestPath = (p: string) => TEST_FILE.test(p) || TEST_PATH.test(p);

/** A repo-relative path with no way out of the repo, or null when the entry is not one. */
function normalizePath(raw: string): string | null {
  let p = raw.trim().replace(/^`+|`+$/g, '').replace(/^\.\//, '');
  if (!p || /\s/.test(p) || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.includes('\\')) return null;
  if (p.split('/').some((seg) => seg === '..')) return null;
  p = p.replace(/\/{2,}/g, '/');
  return p;
}

class RepoPaths {
  private readonly files: Set<string>;
  private readonly dirs = new Set<string>();

  constructor(files: string[] | null) {
    this.files = new Set(files ?? []);
    for (const f of this.files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    }
  }

  hasFile(p: string) {
    return this.files.has(p);
  }

  /** The path as it should be written (directories end in `/`), or null when absent. */
  resolve(raw: string): { path: string; isDir: boolean } | null {
    const p = normalizePath(raw);
    if (!p) return null;
    const bare = p.replace(/\/$/, '');
    if (!p.endsWith('/') && this.files.has(bare)) return { path: bare, isDir: false };
    if (this.dirs.has(bare)) return { path: `${bare}/`, isDir: true };
    return null;
  }
}

// --- the mapper -------------------------------------------------------------

function rewriter() {
  let count = 0;
  const rw = (s: string): string => {
    const r = rewriteModals(oneLine(s));
    if (r.changed) count++;
    return r.text;
  };
  return { rw, count: () => count };
}

function exampleAc(n: number, ex: SpecExample, rw: (s: string) => string, suffix = ''): string {
  const given = ex.given && ex.given.trim() ? `GIVEN ${rw(ex.given)} ` : '';
  return `- AC-${n}: ${given}WHEN ${rw(ex.when)} THEN ${rw(ex.then)}${suffix}`;
}

function renderBlock(
  fmt: SpecFormat,
  title: string,
  cap: SpecCapabilityAnswers,
  firstAc: number,
  surface: string[],
  outOfScope: string[],
  rw: (s: string) => string,
): { text: string; acCount: number } {
  const name = upperFirst(rw(cap.name).replace(/^must\s+/i, ''));
  const statement = `${title} MUST ${lowerFirst(name)}.`;

  const acs = [
    exampleAc(firstAc, cap.accepted, rw),
    exampleAc(firstAc + 1, cap.rejected, rw, ' (rejection case)'),
    ...cap.invariants.map((inv, i) => `- AC-${firstAc + 2 + i}: GIVEN any input WHEN ${title} is asked to ${lowerFirst(name)} THEN ${rw(inv)}`),
  ];

  const section = (key: Section, body: string[]) =>
    fmt.style === 'heading'
      ? [`### ${fmt.labels[key]}`, '', ...body, '']
      : [`**${fmt.labels[key]}**:`, '', ...body, ''];

  const lines = [
    `## ${name}`,
    '',
    ...(fmt.style === 'heading'
      ? [`### ${fmt.labels.capability}`, '', statement, '']
      : [`**${fmt.labels.capability}**: ${statement}`, '']),
    ...section('invariants', cap.invariants.map((inv) => `- ${rw(inv)}`)),
    ...section('acceptance', acs),
    ...section('codeSurface', surface.length ? surface.map((p) => `- \`${p}\``) : ['- None recorded: no path named in the interview exists in the repository yet.']),
    ...section('outOfScope', outOfScope.length ? outOfScope.map((o) => `- ${rw(o)}`) : ['- None declared by the owner yet.']),
  ];
  return { text: lines.join('\n'), acCount: acs.length };
}

function summaryFor(title: string, description: string, names: string[]): string {
  const original = firstSentence(description);
  // Only an owner-written MUST is a claim the owner made; a rewritten "may" is not.
  if (/\bMUST\b/.test(original) && original.length <= MAX_SUMMARY_CHARS && !original.startsWith('[')) {
    return rewriteModals(original).text;
  }
  for (let n = names.length; n >= 1; n--) {
    const s = `${title} MUST ${joinList(names.slice(0, n).map(lowerFirst))}.`;
    if (s.length <= MAX_SUMMARY_CHARS) return s;
  }
  return `${title} MUST ${lowerFirst(names[0])}.`.slice(0, MAX_SUMMARY_CHARS);
}

export function authorSpec(input: SpecAuthoringInput): SpecAuthoringResult {
  const issues = validateInterviewAnswers(input.answers);
  if (issues.length > 0) return { ok: false, errors: issues };

  const a = input.answers;
  const warnings: string[] = [];
  const { rw, count } = rewriter();

  const title = rw(a.title);
  const slug = slugify(title);
  if (!slug) {
    return { ok: false, errors: [{ path: 'title', message: 'Q1: the product name needs letters or digits to make a file name from.' }] };
  }

  const specsRoot = input.specsRoot?.replace(/\/+$/, '') || DEFAULT_SPECS_ROOT;
  const path = `${specsRoot}/${slug}.md`;
  const repo = new RepoPaths(input.files);
  if (repo.hasFile(path)) {
    return {
      ok: false,
      conflict: true,
      errors: [{ path: 'title', message: `${path} already exists. Pick a different product name or edit that spec directly.` }],
    };
  }

  if (input.files === null) {
    warnings.push('The repository tree could not be read, so no code path or test file was verified and none is claimed.');
  } else if (input.truncated) {
    warnings.push('The repository tree was truncated, so paths missing from it were treated as absent.');
  }

  const fmt = inferFormat(input.mirrorSpecs ?? []);

  // Code surface and verification: only what the file list proves exists.
  const droppedCode: string[] = [];
  const surfaces: string[][] = a.capabilities.map((cap) => {
    const kept: string[] = [];
    for (const raw of cap.codePaths ?? []) {
      const r = repo.resolve(raw);
      if (r) {
        if (!kept.includes(r.path)) kept.push(r.path);
      } else droppedCode.push(raw);
    }
    return kept;
  });

  const verifiedBy: string[] = [];
  const droppedVerification: string[] = [];
  for (const raw of a.verification ?? []) {
    const r = repo.resolve(raw);
    if (r && !r.isDir && isTestPath(r.path)) {
      if (!verifiedBy.includes(r.path)) verifiedBy.push(r.path);
    } else droppedVerification.push(raw);
  }
  if (droppedCode.length) warnings.push(`Left out code paths that do not exist in the repository: ${droppedCode.join(', ')}.`);
  if (droppedVerification.length) {
    warnings.push(`Left verified_by empty for entries that are not existing test files: ${droppedVerification.join(', ')}.`);
  }

  const outOfScope = (a.outOfScope ?? []).filter((o) => o.trim());
  let acNumber = 1;
  const rendered = a.capabilities.map((cap, i) => {
    const block = renderBlock(fmt, title, cap, acNumber, surfaces[i], outOfScope, rw);
    acNumber += block.acCount;
    return block;
  });
  for (const b of rendered) {
    if (b.acCount < MIN_ACCEPTANCE_CRITERIA_PER_BLOCK) {
      return { ok: false, errors: [{ path: 'capabilities', message: 'Every capability needs at least one invariant so it gets three acceptance criteria.' }] };
    }
  }

  const description = rw(a.description);
  const summary = summaryFor(title, a.description, a.capabilities.map((c) => upperFirst(rw(c.name).replace(/^must\s+/i, ''))));

  const domainRaw = a.domain?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const domain = domainRaw || DEFAULT_DOMAIN;
  if (!domainRaw) {
    warnings.push(`domain defaulted to "${DEFAULT_DOMAIN}"; set it to a value from the spec format's domain vocabulary before merging.`);
  }

  const surfaceFiles = [...new Set(surfaces.flat().filter((p) => !p.endsWith('/')))].slice(0, MAX_SURFACES);
  const allowAssertions = fmt.source === 'default' || fmt.keyOrder.includes('assertions');

  const values: Record<string, string[] | null> = {
    title: [`title: ${yamlScalar(title)}`],
    status: ['status: draft'],
    owner: [`owner: ${yamlScalar(input.owner)}`],
    last_verified: [`last_verified: ${input.today}`],
    summary: [`summary: ${yamlScalar(summary)}`],
    domain: [`domain: ${domain}`],
    surfaces: surfaceFiles.length ? [`surfaces: [${surfaceFiles.join(', ')}]`] : null,
    verified_by: verifiedBy.length ? [`verified_by: [${verifiedBy.join(', ')}]`] : null,
    assertions:
      verifiedBy.length && allowAssertions
        ? ['assertions:', ...verifiedBy.flatMap((p, i) => [`  - id: ${JSON.stringify(`test-${i + 1}`)}`, '    type: "test_file"', `    path: ${JSON.stringify(p)}`])]
        : null,
  };
  const order = [
    ...fmt.keyOrder.filter((k) => (KNOWN_KEYS as readonly string[]).includes(k)),
    ...REQUIRED_KEYS.filter((k) => !fmt.keyOrder.includes(k)),
    ...KNOWN_KEYS.filter((k) => !fmt.keyOrder.includes(k) && !(REQUIRED_KEYS as readonly string[]).includes(k)),
  ];
  const frontLines = [...new Set(order)].flatMap((k) => values[k] ?? []);

  const markdown =
    [
      '---',
      ...frontLines,
      '---',
      `# ${title}`,
      '',
      description,
      '',
      ...rendered.map((b) => b.text),
    ]
      .join('\n')
      .replace(/\n+$/, '') + '\n';

  if (count() > 0) {
    warnings.push(`Rewrote ${count()} "should"/"may" in the answers to MUST/MUST NOT; the spec format bans both words.`);
  }

  const protectedPaths: string[] = [];
  const notes: string[] = [];
  for (const raw of (a.protectedAreas ?? []).map((s) => s.trim()).filter(Boolean)) {
    const r = repo.resolve(raw);
    if (r) protectedPaths.push(r.path);
    else notes.push(raw);
  }

  return {
    ok: true,
    path,
    slug,
    specsRoot,
    markdown,
    format: fmt.source,
    warnings,
    dropped: { codePaths: droppedCode, verification: droppedVerification },
    mergePolicy: { paths: protectedPaths, notes },
  };
}

/** The task description: the file to add, verbatim, and the rules the PR follows. */
export function buildAuthorSpecTaskDescription(opts: { path: string; markdown: string; defaultBranch: string }): string {
  const ticks = '`'.repeat(Math.max(3, ...[...opts.markdown.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return [
    'Add one draft spec to this repository. The owner wrote the answers it was rendered from, previewed it, and reviews the PR before it merges.',
    '',
    '## How to work',
    '',
    `- Add exactly one file, \`${opts.path}\`, with the content below. Change nothing else: no other file, no format document, no index.`,
    '- Keep `status: draft`. Do not promote it, add assertions, or add `verified_by` entries beyond what is shown; the owner promotes it later.',
    '- Before committing, confirm every path named in the file exists and that nothing in it says "should" or "may". Fix a dead path by removing it, not by inventing a replacement.',
    `- Commit it as \`docs(spec): add draft spec\` on your task branch. Base the PR on \`${opts.defaultBranch}\`.`,
    `- Never commit or push to the default branch \`${opts.defaultBranch}\`. Do not merge the PR: the owner reviews and merges it.`,
    '',
    `## \`${opts.path}\``,
    '',
    ticks,
    opts.markdown.replace(/\n$/, ''),
    ticks,
    '',
  ]
    .join('\n');
}
