#!/usr/bin/env bun
/**
 * Copy check: a ratchet over AI-voice UI copy in apps/web.
 *
 *   bun run copy:check                            # fail if any rule's total rose
 *   bun run copy:check --update                   # lower the baseline to today's counts
 *   bun run copy:check --update --allow-increase  # deliberately raise it
 *
 * Extracts rendered strings with the TypeScript AST (JSX text, string and
 * template literals; comments, imports and class lists never count) and runs
 * them through the rules in packages/core/copy-rules.ts. Same ratchet shape as
 * scripts/design-check.ts: per-file counts per rule, the gate compares totals,
 * a failure lists every hit in the files whose count rose.
 *
 * Fails closed: an unparseable baseline, or a missing one in CI, exits non-zero.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import * as ts from 'typescript';
import { COPY_RULES, copyViolations, type CopyRuleId } from '../packages/core/copy-rules';

export const BASELINE_FILE = 'scripts/copy-check.baseline.json';

/** Rendered app surface: pages, components and their copy helpers. API routes are not UI. */
export function inScope(path: string): boolean {
  if (!/^apps\/web\/src\/(app|components)\//.test(path)) return false;
  if (path.startsWith('apps/web/src/app/api/')) return false;
  if (!/\.tsx?$/.test(path)) return false;
  return !/\.(test|stories|fixtures?)\.tsx?$/.test(path) && !path.includes('/__tests__/') && !path.startsWith('apps/web/src/app/app/dev/');
}

/** Attribute values that are never rendered text. */
const NON_COPY_ATTR = /^(className|class|style|href|src|id|key|type|htmlFor|name|role|rel|target|method|action|autoComplete|inputMode|pattern|data-[\w-]+|testId|variant|tone|size|as|viewBox|d|fill|stroke|xmlns)$/;
/** Calls whose string arguments are code, not copy. */
const NON_COPY_CALL = /^(console\.\w+|cn|clsx|cx|twMerge|fetch|require|import|router\.(push|replace)|redirect|searchParams\.\w+|URLSearchParams|new URL|JSON\.parse|\w+\.(startsWith|endsWith|includes|split|replace|match|test|querySelector(All)?|getAttribute|setAttribute|addEventListener|removeEventListener)|encodeURIComponent)$/;

const looksLikeClassList = (t: string) => {
  const parts = t.trim().split(/\s+/);
  return parts.every((p) => /^[!a-z0-9:_\-[\]/.%#()&>*,=@]+$/.test(p)) && parts.some((p) => p.includes('-') || p.includes(':'));
};
/** A rendered string has at least two words and a letter. */
const isProse = (t: string) => /[A-Za-z]{2}/.test(t) && /\S\s+\S/.test(t) && !looksLikeClassList(t) && !/^(\/|https?:|[\w.-]+\/)/.test(t.trim());

function calleeName(node: ts.Node): string | null {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const text = node.expression.getText();
    return ts.isNewExpression(node) ? `new ${text}` : text;
  }
  return null;
}

/** True when a literal sits somewhere its value is code, not copy. */
function isNonCopyContext(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
    if (ts.isJsxAttribute(p)) return NON_COPY_ATTR.test(p.name.getText());
    if (ts.isPropertyAssignment(p) && NON_COPY_ATTR.test(p.name.getText().replace(/['"]/g, ''))) return true;
    const callee = calleeName(p);
    if (callee && NON_COPY_CALL.test(callee)) return true;
    if (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText())) return true;
    if (ts.isCaseClause(p) || ts.isElementAccessExpression(p) || ts.isTypeNode(p)) return true;
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isJsxElement(p)) return false;
  }
  return false;
}

const hasDirectText = (el: ts.JsxElement) => el.children.some((c) => ts.isJsxText(c) && /[A-Za-z]/.test(c.text));

/** Rendered text of a JSX subtree; expressions become "N" so a sentence stays whole. */
function flattenJsx(nodes: ts.NodeArray<ts.JsxChild>): string {
  return nodes.map((c) => {
    if (ts.isJsxText(c)) return c.text.replace(/&apos;/g, '\'').replace(/&[a-z]+;/g, '"');
    if (ts.isJsxElement(c)) return flattenJsx(c.children);
    if (ts.isJsxExpression(c) && c.expression && (ts.isStringLiteral(c.expression) || ts.isNoSubstitutionTemplateLiteral(c.expression))) return c.expression.text;
    return ts.isJsxExpression(c) && c.expression ? 'N' : '';
  }).join('');
}

export interface CopyString { line: number; text: string }

/** Every rendered string in one source file. Pure, so tests can feed fixtures. */
export function extractCopy(path: string, content: string): CopyString[] {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: CopyString[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const push = (n: ts.Node, text: string) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (isProse(t)) out.push({ line: lineOf(n), text: t });
  };
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) && hasDirectText(n)) {
      // One string per sentence-bearing element; a nested <strong> is part of its parent's sentence.
      const parentEl = n.parent && ts.isJsxElement(n.parent) ? n.parent : undefined;
      if (!parentEl || !hasDirectText(parentEl)) push(n, flattenJsx(n.children));
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isJsxExpression(n.parent) && !isNonCopyContext(n)) {
      push(n, n.text);
    } else if (ts.isTemplateExpression(n) && !isNonCopyContext(n)) {
      push(n, n.head.text + n.templateSpans.map((s) => `N${s.literal.text}`).join(''));
    } else if (ts.isJsxExpression(n) && n.expression && (ts.isStringLiteral(n.expression) || ts.isNoSubstitutionTemplateLiteral(n.expression))
      && !(n.parent && ts.isJsxElement(n.parent))) {
      if (!isNonCopyContext(n.expression)) push(n, n.expression.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export interface Violation { file: string; line: number; rule: CopyRuleId; text: string }
export type Counts = Record<CopyRuleId, Record<string, number>>;

export function scanSources(sources: { path: string; content: string }[]): { counts: Counts; violations: Violation[] } {
  const counts = Object.fromEntries(COPY_RULES.map((r) => [r.id, {}])) as Counts;
  const violations: Violation[] = [];
  for (const { path, content } of sources) {
    if (!inScope(path)) continue;
    for (const s of extractCopy(path, content)) {
      for (const rule of copyViolations(s.text)) {
        violations.push({ file: path, line: s.line, rule: rule.id, text: s.text });
        counts[rule.id][path] = (counts[rule.id][path] ?? 0) + 1;
      }
    }
  }
  return { counts, violations };
}

/** Tracked files only, so the check sees what ships. */
export function readSources(): { path: string; content: string }[] {
  const ls = spawnSync('git', ['ls-files', '-z', 'apps/web/src'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  return ls.stdout.split('\0').filter(inScope).sort().map((path) => ({ path, content: readFileSync(path, 'utf8') }));
}

const total = (perFile: Record<string, number> = {}) => Object.values(perFile).reduce((a, b) => a + b, 0);

export function parseBaseline(raw: string): Counts {
  const parsed = JSON.parse(raw);
  for (const rule of COPY_RULES) {
    const perFile = parsed?.[rule.id];
    if (!perFile || typeof perFile !== 'object') throw new Error(`baseline is missing rule '${rule.id}'`);
    for (const [file, n] of Object.entries(perFile)) {
      if (!Number.isInteger(n) || (n as number) < 0) throw new Error(`baseline ${rule.id}['${file}'] is not a count`);
    }
  }
  return parsed as Counts;
}

export function serializeBaseline(counts: Counts): string {
  const sorted: Record<string, Record<string, number>> = {};
  for (const rule of COPY_RULES) {
    const perFile = counts[rule.id] ?? {};
    sorted[rule.id] = Object.fromEntries(Object.keys(perFile).sort().map((f) => [f, perFile[f]]));
  }
  return JSON.stringify(sorted, null, 2) + '\n';
}

export interface Regression { rule: CopyRuleId; baseline: number; current: number; offenders: Violation[] }

export function findRegressions(baseline: Counts, current: Counts, violations: Violation[]): Regression[] {
  const out: Regression[] = [];
  for (const rule of COPY_RULES) {
    const base = baseline[rule.id] ?? {};
    const now = current[rule.id] ?? {};
    if (total(now) <= total(base)) continue;
    const rose = new Set(Object.keys(now).filter((f) => now[f] > (base[f] ?? 0)));
    out.push({ rule: rule.id, baseline: total(base), current: total(now), offenders: violations.filter((v) => v.rule === rule.id && rose.has(v.file)) });
  }
  return out;
}

/** Without allowIncrease each file keeps min(baseline, current): paid-down debt locks in, new debt is refused. */
export function updatedBaseline(baseline: Counts, current: Counts, allowIncrease: boolean): { next: Counts; refused: CopyRuleId[] } {
  const next = {} as Counts;
  const refused: CopyRuleId[] = [];
  for (const rule of COPY_RULES) {
    const base = baseline[rule.id] ?? {};
    const now = current[rule.id] ?? {};
    if (allowIncrease) { next[rule.id] = { ...now }; continue; }
    if (total(now) > total(base)) refused.push(rule.id);
    const perFile: Record<string, number> = {};
    for (const [file, n] of Object.entries(now)) {
      const kept = Math.min(n, base[file] ?? 0);
      if (kept > 0) perFile[file] = kept;
    }
    next[rule.id] = perFile;
  }
  return { next, refused };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const { counts, violations } = scanSources(readSources());

  if (args.has('--list')) {
    for (const v of violations) console.log(`${v.file}:${v.line} [${v.rule}] ${v.text.slice(0, 160)}`);
    return;
  }

  if (!existsSync(BASELINE_FILE)) {
    if (process.env.CI) {
      console.error(`❌ ${BASELINE_FILE} is missing. Restore it; CI never regenerates the baseline.`);
      process.exit(1);
    }
    writeFileSync(BASELINE_FILE, serializeBaseline(counts));
    console.log(`📋 No baseline found; wrote ${BASELINE_FILE} from the current tree.`);
    return;
  }

  const baseline = parseBaseline(readFileSync(BASELINE_FILE, 'utf8'));

  if (args.has('--update')) {
    const { next, refused } = updatedBaseline(baseline, counts, args.has('--allow-increase'));
    if (refused.length > 0) {
      console.error(`❌ Refusing to raise the baseline for: ${refused.join(', ')}. Rewrite the new copy, or pass --allow-increase deliberately.`);
      process.exit(1);
    }
    writeFileSync(BASELINE_FILE, serializeBaseline(next));
    console.log(`✅ Wrote ${BASELINE_FILE}.`);
    return;
  }

  console.log('✍️  Copy check\n');
  console.log('   Rule                 | Current | Baseline');
  for (const rule of COPY_RULES) {
    console.log(`   ${rule.id.padEnd(20)} | ${String(total(counts[rule.id])).padEnd(7)} | ${total(baseline[rule.id])}`);
  }

  const regressions = findRegressions(baseline, counts, violations);
  if (regressions.length === 0) {
    const lowered = COPY_RULES.some((r) => total(counts[r.id]) < total(baseline[r.id]));
    console.log(`\n✅ Copy check passed.${lowered ? ' Debt went down. Run `bun run copy:check --update` to lock it in.' : ''}`);
    return;
  }

  for (const r of regressions) {
    const rule = COPY_RULES.find((x) => x.id === r.rule)!;
    console.log(`\n❌ ${rule.name} rose from ${r.baseline} to ${r.current}. ${rule.why}`);
    console.log(`   Bad:  ${rule.bad}\n   Good: ${rule.good}`);
    for (const v of r.offenders) console.log(`   ${v.file}:${v.line}: ${v.text.slice(0, 160)}`);
  }
  console.log('\n❌ New AI-voice copy. Rewrite the strings above (docs/design/design-system.md §5).');
  process.exit(1);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`❌ copy check failed: ${(err as Error).message}`);
    process.exit(2);
  }
}
