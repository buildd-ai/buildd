/**
 * Copy review: a workspace that opts in (`gitConfig.copyReview`, see
 * `CopyReviewConfig` in @buildd/shared) has the reviewer judge the
 * user-facing strings a PR adds against the workspace's voice guide.
 *
 *   changedCopyStrings     the strings a PR adds to UI files, from its patches
 *   renderCopyReviewSection the reviewer prompt section (strings, voice guide,
 *                           lint command, the Copy Editor role's instructions)
 *   applyCopyReviewGate    what the reviewer's copyFindings do to the verdict:
 *                           'review' only reports, 'gate' turns an approval with
 *                           strings to rewrite into request-changes
 *
 * Strings only, never the whole diff, so the copy pass stays cheap. Extraction
 * is patch-based: each hunk's new side is parsed with the TypeScript parser
 * (tolerant of partial code) and only strings on added lines count. Same
 * idea and same exclusions as scripts/copy-check.ts, which scans whole files.
 */
import * as ts from 'typescript';
import type { CopyReviewConfig, CopyReviewMode } from '@buildd/shared';
import { copyViolations } from '@buildd/core/copy-rules';
import type { GithubPrFile } from './reviewer-patch';

export interface ChangedCopyString {
  path: string;
  /** New-side line number. */
  line: number;
  text: string;
  /** Ids of the copy rules (packages/core/copy-rules.ts) this string already breaks. */
  ruleHits: string[];
}

export interface CopyFinding {
  path: string;
  line?: number;
  text: string;
  verdict: 'ok' | 'rewrite';
  rewrite?: string;
  reason?: string;
}

/** Cap on strings sent to the reviewer: a PR that adds more is reviewed on the first ones. */
export const COPY_REVIEW_MAX_STRINGS = 80;

const DEFAULT_UI_PATH = /(^|\/)(app|components|pages|views|ui|src\/routes)\/.*\.(tsx|jsx|vue|svelte|html|astro|mdx)$/;
const NON_UI_PATH = /(^|\/)(api|__tests__|tests?|fixtures?|stories)\/|\.(test|spec|stories|fixtures?)\.[a-z]+$/;

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function isCopyPath(path: string, config: Pick<CopyReviewConfig, 'paths'>): boolean {
  if (NON_UI_PATH.test(path)) return false;
  if (config.paths?.length) return config.paths.some((g) => globToRegExp(g).test(path));
  return DEFAULT_UI_PATH.test(path);
}

/** Attribute names and calls whose strings are code, not copy (mirrors scripts/copy-check.ts). */
const NON_COPY_ATTR = /^(className|class|style|href|src|id|key|type|htmlFor|name|role|rel|target|method|action|autoComplete|inputMode|pattern|data-[\w-]+|testId|variant|tone|size|as|viewBox|d|fill|stroke|xmlns)$/;
const NON_COPY_CALL = /^(console\.\w+|cn|clsx|cx|twMerge|fetch|require|import|router\.(push|replace)|redirect|URLSearchParams|JSON\.parse|encodeURIComponent|\w+\.(startsWith|endsWith|includes|split|replace|match|test|get|set|has))$/;

function isNonCopyContext(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return NON_COPY_ATTR.test(p.name.getText());
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const callee = p.expression.getText().replace(/\s+/g, '');
      if (NON_COPY_CALL.test(callee)) return true;
    }
    if (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText())) return true;
    if (ts.isCaseClause(p) || ts.isElementAccessExpression(p) || ts.isTypeNode(p)) return true;
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isJsxElement(p)) return false;
  }
  return false;
}

/** Text a person reads: has a letter, isn't a class list, path, identifier or URL. */
function isCopy(t: string): boolean {
  if (!/[A-Za-z]/.test(t)) return false;
  if (/^[a-z][\w.-]*$/.test(t) && !/\s/.test(t) && t.toLowerCase() === t) return false; // identifiers, keys
  if (/^(\/|https?:|#|\.\/|@)/.test(t)) return false;
  const parts = t.trim().split(/\s+/);
  if (parts.every((p) => /^[!a-z0-9:_\-[\]/.%#()&>*,=@]+$/.test(p)) && parts.some((p) => p.includes('-') || p.includes(':'))) return false;
  return true;
}

interface Hunk { startLine: number; lines: Array<{ text: string; added: boolean }> }

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const raw of patch.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) { cur = { startLine: Number(m[1]), lines: [] }; hunks.push(cur); continue; }
    if (!cur) continue;
    if (raw.startsWith('-') || raw.startsWith('\\')) continue; // old side only
    cur.lines.push({ text: raw.slice(1), added: raw.startsWith('+') });
  }
  return hunks;
}

function stringsFromHunk(path: string, hunk: Hunk): Array<{ line: number; text: string }> {
  const addedLines = new Set<number>();
  hunk.lines.forEach((l, i) => { if (l.added) addedLines.add(hunk.startLine + i); });
  if (addedLines.size === 0) return [];
  const source = hunk.lines.map((l) => l.text).join('\n');
  const out: Array<{ line: number; text: string }> = [];

  if (!/\.(tsx|jsx|ts|js)$/.test(path)) {
    hunk.lines.forEach((l, i) => {
      if (!l.added) return;
      const t = l.text.replace(/<[^>]+>/g, ' ').replace(/[#*_`>]/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
      if (isCopy(t) && /\s/.test(t)) out.push({ line: hunk.startLine + i, text: t });
    });
    return out;
  }

  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const push = (n: ts.Node, text: string) => {
    const line = hunk.startLine + sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
    const t = text.replace(/\s+/g, ' ').trim();
    if (addedLines.has(line) && isCopy(t)) out.push({ line, text: t });
  };
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) { push(n, n.text); return; }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !isNonCopyContext(n)) {
      // A bare string literal is copy only when it reads as prose.
      if (/\s/.test(n.text) || ts.isJsxExpression(n.parent)) push(n, n.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The user-facing strings a PR adds, in file order. */
export function changedCopyStrings(
  files: Array<Pick<GithubPrFile, 'filename' | 'patch' | 'status'>>,
  config: Pick<CopyReviewConfig, 'paths'>,
): ChangedCopyString[] {
  const out: ChangedCopyString[] = [];
  for (const f of files) {
    if (f.status === 'removed' || !f.patch || !isCopyPath(f.filename, config)) continue;
    for (const hunk of parseHunks(f.patch)) {
      for (const s of stringsFromHunk(f.filename, hunk)) {
        out.push({ path: f.filename, line: s.line, text: s.text, ruleHits: copyViolations(s.text).map((r) => r.id) });
      }
    }
  }
  return out;
}

/** Fallback when the workspace has no Copy Editor role. */
export const DEFAULT_COPY_INSTRUCTIONS = [
  'Read each string as if a terse engineer wrote it on a label maker. If it sounds like a chatbot, rewrite it.',
  'Labels are nouns, buttons are verbs, numbers first, present tense, sentence case.',
  'Say what a thing does, once. No lists of what it does not do ("Not X: because..."), no internals, no reassurance, no narration of the screen.',
].join('\n');

/** The reviewer prompt section. Empty when the PR adds no copy. */
export function renderCopyReviewSection(params: {
  config: CopyReviewConfig;
  strings: ChangedCopyString[];
  instructions: string;
}): string {
  const { config, strings } = params;
  if (strings.length === 0) return '';
  const shown = strings.slice(0, COPY_REVIEW_MAX_STRINGS);
  const lines = shown.map((s) => `- ${s.path}:${s.line} ${JSON.stringify(s.text)}${s.ruleHits.length ? `  [copy rules: ${s.ruleHits.join(', ')}]` : ''}`);
  const more = strings.length > shown.length ? `\n(${strings.length - shown.length} more strings not listed.)` : '';
  const effect = config.mode === 'gate'
    ? 'This workspace REQUIRES copy review: any string you mark `rewrite` sends the PR back to the builder with your rewrite, whatever your verdict.'
    : 'This workspace reports copy findings on the PR; they do not change your verdict.';
  return [
    '',
    '',
    '## Copy review',
    '',
    `Judge only the user-facing strings this PR adds, listed below, against the voice guide \`${config.voiceGuide}\` (read it in the checkout). ${effect}`,
    config.lintCommand ? `\nRun \`${config.lintCommand}\` in the checkout and treat a failure it attributes to these files as a \`rewrite\`.` : '',
    '',
    '### How to judge',
    '',
    params.instructions.trim() || DEFAULT_COPY_INSTRUCTIONS,
    '',
    '### Strings this PR adds',
    '',
    ...lines,
    more,
    '',
    'Return `copyFindings`: one entry per string you judged, `{ path, line, text, verdict: "ok" | "rewrite", rewrite, reason }`. `rewrite` is the exact replacement text; `reason` names the rule broken. Mark `ok` when a string is already plain; never rewrite to make it merely different.',
  ].filter((l) => l !== undefined).join('\n');
}

export function parseCopyFindings(raw: unknown): CopyFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: CopyFinding[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.path !== 'string' || typeof o.text !== 'string') continue;
    if (o.verdict !== 'ok' && o.verdict !== 'rewrite') continue;
    if (o.verdict === 'rewrite' && (typeof o.rewrite !== 'string' || !o.rewrite.trim())) continue;
    out.push({
      path: o.path,
      text: o.text,
      verdict: o.verdict,
      ...(typeof o.line === 'number' ? { line: o.line } : {}),
      ...(typeof o.rewrite === 'string' ? { rewrite: o.rewrite } : {}),
      ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
    });
  }
  return out;
}

function formatRewrites(findings: CopyFinding[]): string {
  return findings
    .filter((f) => f.verdict === 'rewrite')
    .map((f) => `- ${f.path}${f.line ? `:${f.line}` : ''}: ${JSON.stringify(f.text)} -> ${JSON.stringify(f.rewrite)}${f.reason ? ` (${f.reason})` : ''}`)
    .join('\n');
}

/**
 * What the copy findings do to a verdict. Only `approve` and `request-changes`
 * are touched: an escalation already goes to a person, who sees the note.
 */
export function applyCopyReviewGate(params: {
  verdict: 'approve' | 'request-changes' | 'escalate';
  mode: CopyReviewMode | null;
  findings: CopyFinding[];
  feedback: string | undefined;
}): { verdict: 'approve' | 'request-changes' | 'escalate'; feedback: string | undefined; reason: string | null; note: string | null } {
  const { verdict, mode, findings, feedback } = params;
  const rewrites = formatRewrites(findings);
  if (!mode || !rewrites) return { verdict, feedback, reason: null, note: null };
  const note = `Copy review: rewrite these strings.\n${rewrites}`;
  if (mode === 'review' || verdict === 'escalate') return { verdict, feedback, reason: null, note };
  return {
    verdict: 'request-changes',
    feedback: feedback ? `${feedback}\n\n${note}` : note,
    reason: verdict === 'approve' ? 'the workspace requires copy review and some changed strings need rewriting' : null,
    note,
  };
}
