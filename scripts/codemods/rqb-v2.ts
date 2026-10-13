#!/usr/bin/env bun
// Codemod: relational queries (db.query.<t>.findFirst / findMany) from drizzle
// 0.45's RQB v1 to drizzle v1's RQB v2. Run it on the 0.45 tree, in the same
// change that bumps drizzle-orm and drizzle-kit; the output does not type-check
// on 0.45 (it has no defineRelations and no `{ RAW }` filters).
//
//   bun scripts/codemods/rqb-v2.ts           # dry run: report what would change
//   bun scripts/codemods/rqb-v2.ts --write   # rewrite the files
//
// What it does, all behaviour-preserving:
//
// 1. Relations. Every `relations(table, ({ one, many }) => ...)` block in
//    packages/core/db/schema.ts becomes one entry of a single
//    `defineRelations(schema, (r) => ...)` in packages/core/db/relations.ts.
//    - `one(T, { fields, references, relationName })`
//        -> `r.one.T({ from, to, optional: false?, alias? })`.
//      v1 typed a `one` as non-null when every `fields` column is NOT NULL;
//      v2 needs `optional: false` for that, so it is set on exactly those.
//    - `many(T, { relationName })` -> `r.many.T({ from, to, alias? })`, with
//      from/to taken from the reverse `one` on T that v1 paired it with (same
//      target, same relationName). An unpaired `many` is an error: v1 would
//      have thrown on it at query time too.
//    - every `drizzle({ ..., schema })` passes `relations` instead, and
//      `drizzle<typeof schema>` becomes `drizzle<typeof relations>`.
//
// 2. Call sites. Each config passed to findFirst / findMany is rewritten, and
//    so is every nested `with` config, following identifiers, spreads,
//    conditionals and helper functions to their declarations (also across
//    files) with the type checker:
//    - `where: <SQL>`       -> `where: sqlWhere(<SQL>)`
//    - `where: (t, ops) => ...` -> `where: { RAW: sqlWhereFn((t, ops) => ...) }`
//    - `orderBy: <SQL | column | array>` -> `orderBy: sqlOrderBy(...)`
//    - `orderBy: (t, ops) => ...` -> `orderBy: sqlOrderByFn((t, ops) => ...)`
//    - `extras: { k: sql`...`.as('k') }` -> `extras: sqlExtras({ ... })`
//    - `extras: (t, { sql }) => ({ k: ... })` -> `extras: { k: (t, { sql }) => ... }`
//    The helpers (packages/core/db/relational-sql.ts) re-point the query
//    table's columns at the alias RQB v2 gives it, which v1 did implicitly,
//    for callbacks too: v1 re-pointed a callback's result as well. Without that, `eq(tasks.id, x)` renders against
//    `"tasks"` while the query reads `from "tasks" as "d0"`.
//    The rewrite is deliberately uniform (no `{ id: x }` object filters):
//    v2 skips an undefined object-filter value, where v1's eq(col, undefined)
//    still filtered. Turning filters into objects is a later, per-site job.
//
// Anything it cannot place is reported and makes the run exit non-zero.

import ts from 'typescript';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { execFileSync } from 'child_process';

// ── Text edits ──────────────────────────────────────────────────────────────

export interface Edit {
  pos: number;
  end: number;
  text: string;
}

/** Apply edits; insertions at one position keep their order of registration. */
export function applyEdits(source: string, edits: Edit[]): string {
  const sorted = edits
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => b.pos - a.pos || b.end - a.end || b.i - a.i);
  let out = source;
  let lastPos = Infinity;
  for (const e of sorted) {
    if (e.end > lastPos) throw new Error(`overlapping edits at ${e.pos}..${e.end}`);
    out = out.slice(0, e.pos) + e.text + out.slice(e.end);
    lastPos = e.pos;
  }
  return out;
}

// ── 1. Relations ────────────────────────────────────────────────────────────

interface OneRel {
  kind: 'one';
  key: string;
  target: string;
  fields: string[];
  references: string[];
  relationName?: string;
  comments: string;
}
interface ManyRel {
  kind: 'many';
  key: string;
  target: string;
  relationName?: string;
  comments: string;
}
type Rel = OneRel | ManyRel;

export interface RelationsResult {
  /** schema.ts with the relations() blocks and the `relations` import removed. */
  schema: string;
  /** The new relations.ts. */
  relations: string;
  errors: string[];
}

function leadingComments(src: string, node: ts.Node): string {
  const ranges = ts.getLeadingCommentRanges(src, node.getFullStart()) ?? [];
  return ranges.map((r) => src.slice(r.pos, r.end)).join('\n');
}

function stringProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name && ts.isStringLiteralLike(p.initializer)) {
      return p.initializer.text;
    }
  }
  return undefined;
}

function columnListProp(obj: ts.ObjectLiteralExpression, name: string, errors: string[]): string[] {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || p.name.getText() !== name) continue;
    if (!ts.isArrayLiteralExpression(p.initializer)) {
      errors.push(`${name} is not an array literal: ${p.getText()}`);
      return [];
    }
    return p.initializer.elements.map((e) => {
      if (!ts.isPropertyAccessExpression(e)) errors.push(`${name} entry is not table.column: ${e.getText()}`);
      return e.getText();
    });
  }
  return [];
}

/** Table export -> column key -> NOT NULL (`.notNull()` or `.primaryKey()`). */
function readNotNull(sf: ts.SourceFile): Map<string, Map<string, boolean>> {
  const tables = new Map<string, Map<string, boolean>>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      const init = d.initializer;
      if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(d.name)) continue;
      if (!/^pg(Table|View)$/.test(init.expression.getText())) continue;
      const colsArg = init.arguments[1];
      if (!colsArg || !ts.isObjectLiteralExpression(colsArg)) continue;
      const cols = new Map<string, boolean>();
      for (const p of colsArg.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        cols.set(p.name.getText(), /\.(notNull|primaryKey)\(\)/.test(p.initializer.getText()));
      }
      tables.set(d.name.text, cols);
    }
  }
  return tables;
}

export function convertRelations(schemaSource: string, opts: { schemaImport?: string } = {}): RelationsResult {
  const errors: string[] = [];
  const sf = ts.createSourceFile('schema.ts', schemaSource, ts.ScriptTarget.Latest, true);
  const notNull = readNotNull(sf);
  const bySource = new Map<string, Rel[]>();
  const order: string[] = [];
  const edits: Edit[] = [];

  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const decl = st.declarationList.declarations[0];
    const init = decl?.initializer;
    if (!init || !ts.isCallExpression(init) || init.expression.getText() !== 'relations') continue;
    const [tableArg, fnArg] = init.arguments;
    if (!tableArg || !ts.isIdentifier(tableArg) || !fnArg || !ts.isArrowFunction(fnArg)) {
      errors.push(`unrecognised relations() call: ${init.getText().slice(0, 120)}`);
      continue;
    }
    let body: ts.Node = fnArg.body;
    while (ts.isParenthesizedExpression(body)) body = body.expression;
    if (!ts.isObjectLiteralExpression(body)) {
      errors.push(`relations(${tableArg.text}) body is not an object literal`);
      continue;
    }
    const source = tableArg.text;
    if (!bySource.has(source)) {
      bySource.set(source, []);
      order.push(source);
    }
    for (const p of body.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isCallExpression(p.initializer)) {
        errors.push(`relations(${source}): unrecognised entry ${p.getText().slice(0, 80)}`);
        continue;
      }
      const call = p.initializer;
      const fn = call.expression.getText();
      const target = call.arguments[0]?.getText() ?? '';
      const cfg = call.arguments[1];
      const cfgObj = cfg && ts.isObjectLiteralExpression(cfg) ? cfg : undefined;
      const key = p.name.getText();
      const comments = leadingComments(schemaSource, p);
      if (fn === 'one') {
        if (!cfgObj) {
          errors.push(`${source}.${key}: one(${target}) without fields/references is not supported`);
          continue;
        }
        bySource.get(source)!.push({
          kind: 'one',
          key,
          target,
          fields: columnListProp(cfgObj, 'fields', errors),
          references: columnListProp(cfgObj, 'references', errors),
          relationName: stringProp(cfgObj, 'relationName'),
          comments,
        });
      } else if (fn === 'many') {
        bySource.get(source)!.push({ kind: 'many', key, target, relationName: cfgObj && stringProp(cfgObj, 'relationName'), comments });
      } else {
        errors.push(`${source}.${key}: unknown relation helper ${fn}`);
      }
    }
    // Remove the statement with its leading comments; the blank lines left
    // behind are collapsed below.
    edits.push({ pos: st.getFullStart(), end: st.getEnd(), text: '\n' });
  }

  const col = (ref: string) => {
    const [table, column] = ref.split('.');
    return { table, column, text: `r.${table}.${column}` };
  };
  const list = (refs: string[]) => (refs.length === 1 ? col(refs[0]).text : `[${refs.map((r) => col(r).text).join(', ')}]`);

  const blocks: string[] = [];
  for (const source of order) {
    const lines: string[] = [];
    for (const rel of bySource.get(source)!) {
      const args: string[] = [];
      if (rel.kind === 'one') {
        for (const f of rel.fields) if (col(f).table !== source) errors.push(`${source}.${rel.key}: field ${f} is not on ${source}`);
        args.push(`from: ${list(rel.fields)}`, `to: ${list(rel.references)}`);
        const cols = notNull.get(source);
        if (!cols) errors.push(`${source}: table definition not found`);
        else if (rel.fields.every((f) => cols.get(col(f).column) === true)) args.push('optional: false');
      } else {
        const candidates = (bySource.get(rel.target) ?? []).filter(
          (r): r is OneRel => r.kind === 'one' && r.target === source && r.relationName === rel.relationName,
        );
        if (candidates.length !== 1) {
          errors.push(
            `${source}.${rel.key}: many(${rel.target}${rel.relationName ? `, '${rel.relationName}'` : ''}) has ${candidates.length} reverse one() relations, need exactly 1`,
          );
          continue;
        }
        const [reverse] = candidates;
        args.push(`from: ${list(reverse.references)}`, `to: ${list(reverse.fields)}`);
      }
      if (rel.relationName) args.push(`alias: '${rel.relationName}'`);
      if (rel.comments) lines.push(...rel.comments.split('\n').map((l) => `    ${l.trim()}`));
      lines.push(`    ${rel.key}: r.${rel.kind}.${rel.target}({ ${args.join(', ')} }),`);
    }
    blocks.push(`  ${source}: {\n${lines.join('\n')}\n  },`);
  }

  let schema = applyEdits(schemaSource, edits).replace(/\n{3,}/g, '\n\n');
  // Drop `relations` from the drizzle-orm import; keep whatever else it brought in.
  schema = schema.replace(/import \{([^}]*)\} from 'drizzle-orm';/, (whole, names: string) => {
    const kept = names.split(',').map((n) => n.trim()).filter((n) => n && n !== 'relations');
    if (kept.length === names.split(',').map((n) => n.trim()).filter(Boolean).length) return whole;
    return kept.length ? `import { ${kept.join(', ')} } from 'drizzle-orm';` : '';
  });

  const relations = `// Relations for drizzle's relational query API (db.query.*), RQB v2.
// Generated from the relations() blocks schema.ts used to hold, by
// scripts/codemods/rqb-v2.ts; edit it by hand from here on.
//
// \`optional: false\` marks a relation whose \`from\` columns are all NOT NULL,
// which RQB v1 typed as non-null. A \`many\` names the columns of the \`one\` it
// pairs with; \`alias\` keeps v1's relationName where there was one.

// The subpath, not 'drizzle-orm': route tests mock.module('drizzle-orm') with
// only the operators they use, and this module loads with the db client.
import { defineRelations } from 'drizzle-orm/relations';
import * as schema from '${opts.schemaImport ?? './schema'}';

export const relations = defineRelations(schema, (r) => ({
${blocks.join('\n')}
}));
`;
  return { schema, relations, errors };
}

// ── 2. Call sites ───────────────────────────────────────────────────────────

const HELPERS_MODULE = 'packages/core/db/relational-sql.ts';
type Helper = 'sqlWhere' | 'sqlWhereFn' | 'sqlOrderBy' | 'sqlOrderByFn' | 'sqlExtras';

export interface CallSiteResult {
  files: Map<string, string>;
  errors: string[];
  stats: Record<string, number>;
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function isUndefinedLiteral(node: ts.Expression): boolean {
  const n = unwrap(node);
  return (ts.isIdentifier(n) && n.text === 'undefined') || n.kind === ts.SyntaxKind.VoidExpression;
}

const HELPERS = new Set(['sqlWhere', 'sqlWhereFn', 'sqlOrderBy', 'sqlOrderByFn', 'sqlExtras']);

/** Already v2: a helper call, or an object filter (`{ RAW }`, `{ id: x }`). */
function isConverted(node: ts.Expression): boolean {
  const n = unwrap(node);
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && HELPERS.has(n.expression.text)) return true;
  return ts.isObjectLiteralExpression(n);
}

function isFunctionLike(node: ts.Expression): node is ts.ArrowFunction | ts.FunctionExpression {
  const n = unwrap(node);
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n);
}

function helperImport(fromFile: string, root: string, helpers: Set<Helper>): string {
  const names = [...helpers].sort().join(', ');
  const rel = relative(root, fromFile);
  let spec: string;
  if (rel.startsWith('apps/') && !rel.startsWith('apps/web/scripts/')) spec = '@buildd/core/db/relational-sql';
  else {
    spec = relative(dirname(fromFile), join(root, HELPERS_MODULE)).replace(/\.ts$/, '');
    if (!spec.startsWith('.')) spec = `./${spec}`;
  }
  return `import { ${names} } from '${spec}';\n`;
}

/** Where a new import line goes: after the last import declaration. */
function importInsertPos(sf: ts.SourceFile): number {
  let pos = 0;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) pos = st.getEnd() + 1;
  }
  return pos;
}

export function transformCallSites(program: ts.Program, files: string[], root: string): CallSiteResult {
  const checker = program.getTypeChecker();
  const edits = new Map<string, Edit[]>();
  const helpers = new Map<string, Set<Helper>>();
  const visited = new Set<string>();
  const errors: string[] = [];
  const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);

  const where = (n: ts.Node) => {
    const sf = n.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
    return `${relative(root, sf.fileName)}:${line + 1}`;
  };
  const edit = (n: ts.Node, e: Edit) => {
    const f = n.getSourceFile().fileName;
    if (!edits.has(f)) edits.set(f, []);
    edits.get(f)!.push(e);
  };
  const wrap = (n: ts.Expression, before: string, after: string) => {
    edit(n, { pos: n.getStart(), end: n.getStart(), text: before });
    edit(n, { pos: n.getEnd(), end: n.getEnd(), text: after });
  };
  const useHelper = (n: ts.Node, h: Helper) => {
    const f = n.getSourceFile().fileName;
    if (!helpers.has(f)) helpers.set(f, new Set());
    helpers.get(f)!.add(h);
  };
  const once = (n: ts.Node, role: string) => {
    const key = `${role}@${n.getSourceFile().fileName}:${n.getStart()}`;
    if (visited.has(key)) return false;
    visited.add(key);
    return true;
  };
  const isCallable = (n: ts.Expression) => {
    const t = checker.getTypeAtLocation(n);
    return t.getCallSignatures().length > 0 || (t.isUnion() && t.types.some((u) => u.getCallSignatures().length > 0));
  };

  /** Declarations behind an identifier / property access / call, for following fragments. */
  const declarationsOf = (n: ts.Expression): ts.Declaration[] => {
    let sym = checker.getSymbolAtLocation(ts.isCallExpression(n) ? n.expression : n);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym?.declarations ?? [];
  };

  /** Follow a non-literal fragment to the expression(s) that define it. */
  const follow = (n: ts.Expression, role: string, visit: (e: ts.Expression) => void) => {
    const decls = declarationsOf(n);
    let found = false;
    for (const d of decls) {
      if (ts.isVariableDeclaration(d) && d.initializer) {
        if (ts.isCallExpression(n)) {
          // A call through a const arrow: visit what the arrow returns.
          const fn = unwrap(d.initializer);
          if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
            found = true;
            returnsOf(fn).forEach(visit);
          }
        } else {
          found = true;
          visit(d.initializer);
        }
      } else if ((ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && ts.isCallExpression(n)) {
        found = true;
        returnsOf(d).forEach(visit);
      } else if (ts.isShorthandPropertyAssignment(d) || ts.isPropertyAssignment(d)) {
        // Unusual: an object property; ignore unless it has an initializer to visit.
        if (ts.isPropertyAssignment(d)) {
          found = true;
          visit(d.initializer);
        }
      }
    }
    if (!found) errors.push(`${where(n)}: cannot resolve ${role} fragment \`${n.getText().slice(0, 80)}\``);
  };

  const returnsOf = (fn: ts.FunctionLikeDeclaration): ts.Expression[] => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out: ts.Expression[] = [];
    const walk = (n: ts.Node) => {
      if (ts.isFunctionLike(n) && n !== fn) return;
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(fn.body, walk);
    return out;
  };

  const transformWhere = (value: ts.Expression, shorthand?: ts.ShorthandPropertyAssignment) => {
    if (isUndefinedLiteral(value) || isConverted(value)) return;
    if (isFunctionLike(value) || isCallable(value)) {
      bump('where:callback');
      useHelper(value, 'sqlWhereFn');
      if (shorthand) edit(shorthand, { pos: shorthand.getStart(), end: shorthand.getEnd(), text: `where: { RAW: sqlWhereFn(${shorthand.name.text}) }` });
      else wrap(value, '{ RAW: sqlWhereFn(', ') }');
      return;
    }
    bump('where:sql');
    useHelper(value, 'sqlWhere');
    if (shorthand) edit(shorthand, { pos: shorthand.getStart(), end: shorthand.getEnd(), text: `where: sqlWhere(${shorthand.name.text})` });
    else wrap(value, 'sqlWhere(', ')');
  };

  const transformOrderBy = (value: ts.Expression, shorthand?: ts.ShorthandPropertyAssignment) => {
    if (isUndefinedLiteral(value) || isConverted(value)) return;
    if (isFunctionLike(value) || isCallable(value)) {
      bump('orderBy:callback');
      useHelper(value, 'sqlOrderByFn');
      if (shorthand) edit(shorthand, { pos: shorthand.getStart(), end: shorthand.getEnd(), text: `orderBy: sqlOrderByFn(${shorthand.name.text})` });
      else wrap(value, 'sqlOrderByFn(', ')');
      return;
    }
    bump('orderBy:sql');
    useHelper(value, 'sqlOrderBy');
    if (shorthand) edit(shorthand, { pos: shorthand.getStart(), end: shorthand.getEnd(), text: `orderBy: sqlOrderBy(${shorthand.name.text})` });
    else wrap(value, 'sqlOrderBy(', ')');
  };

  /** `(t, ops) => ({ k: v })` -> `{ k: (t, ops) => v }`. */
  const splitExtrasCallback = (fn: ts.ArrowFunction | ts.FunctionExpression): boolean => {
    if (!ts.isArrowFunction(fn)) return false;
    const body = unwrap(fn.body as ts.Expression);
    if (!ts.isObjectLiteralExpression(body)) return false;
    const params = `(${fn.parameters.map((p) => p.getText()).join(', ')}) =>`;
    const props = body.properties.map((p) => {
      if (!ts.isPropertyAssignment(p)) throw new Error(`${where(p)}: extras entry is not key: value`);
      return `${p.name.getText()}: ${params} ${p.initializer.getText()}`;
    });
    const multiline = body.getText().includes('\n');
    const indent = multiline ? '\n  ' : ' ';
    const text = `{${indent}${props.join(`,${indent}`)}${multiline ? ',\n' : ' '}}`;
    edit(fn, { pos: fn.getStart(), end: fn.getEnd(), text });
    return true;
  };

  const transformExtras = (value: ts.Expression) => {
    const v = unwrap(value);
    if (ts.isCallExpression(v) && ts.isIdentifier(v.expression) && HELPERS.has(v.expression.text)) return;
    if (isFunctionLike(v)) {
      if (!once(v, 'extras')) return;
      bump('extras:callback');
      if (!splitExtrasCallback(v)) errors.push(`${where(v)}: extras callback must return an object literal`);
      return;
    }
    if (ts.isIdentifier(v) || ts.isPropertyAccessExpression(v)) {
      if (isCallable(v)) {
        follow(v, 'extras', (e) => transformExtras(e));
        return;
      }
    }
    bump('extras:object');
    useHelper(value, 'sqlExtras');
    wrap(value, 'sqlExtras(', ')');
  };

  const transformWithMap = (node: ts.Expression) => {
    const n = unwrap(node);
    if (!once(n, 'with')) return;
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) transformWithValue(p.initializer);
        else if (ts.isSpreadAssignment(p)) transformWithMap(p.expression);
        else if (ts.isShorthandPropertyAssignment(p)) follow(p.name, 'with', transformWithValue);
        else errors.push(`${where(p)}: unrecognised with entry`);
      }
    } else if (ts.isConditionalExpression(n)) {
      transformWithMap(n.whenTrue);
      transformWithMap(n.whenFalse);
    } else if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isCallExpression(n)) {
      follow(n, 'with', transformWithMap);
    } else {
      errors.push(`${where(n)}: unrecognised with map \`${n.getText().slice(0, 80)}\``);
    }
  };

  const transformWithValue = (node: ts.Expression) => {
    const n = unwrap(node);
    if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || isUndefinedLiteral(n)) return;
    transformConfig(n);
  };

  const transformConfig = (node: ts.Expression) => {
    const n = unwrap(node);
    if (!once(n, 'config')) return;
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) {
          const name = p.name.getText();
          if (name === 'where') transformWhere(p.initializer);
          else if (name === 'orderBy') transformOrderBy(p.initializer);
          else if (name === 'extras') transformExtras(p.initializer);
          else if (name === 'with') transformWithMap(p.initializer);
        } else if (ts.isShorthandPropertyAssignment(p)) {
          const name = p.name.text;
          if (name === 'where') transformWhere(p.name, p);
          else if (name === 'orderBy') transformOrderBy(p.name, p);
          else if (name === 'extras') errors.push(`${where(p)}: shorthand extras not supported`);
          else if (name === 'with') follow(p.name, 'with', transformWithMap);
        } else if (ts.isSpreadAssignment(p)) {
          transformConfig(p.expression);
        } else {
          errors.push(`${where(p)}: unrecognised config entry`);
        }
      }
    } else if (ts.isConditionalExpression(n)) {
      transformConfig(n.whenTrue);
      transformConfig(n.whenFalse);
    } else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      transformConfig(n.right);
    } else if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isCallExpression(n)) {
      follow(n, 'config', transformConfig);
    } else {
      errors.push(`${where(n)}: unrecognised config \`${n.getText().slice(0, 80)}\``);
    }
  };

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) {
      errors.push(`${relative(root, file)}: not in the program`);
      continue;
    }
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        (n.expression.name.text === 'findFirst' || n.expression.name.text === 'findMany') &&
        ts.isPropertyAccessExpression(n.expression.expression) &&
        ts.isPropertyAccessExpression(n.expression.expression.expression) &&
        n.expression.expression.expression.name.text === 'query'
      ) {
        bump('calls');
        if (n.arguments[0]) transformConfig(n.arguments[0]);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  const out = new Map<string, string>();
  for (const [file, fileEdits] of edits) {
    const sf = program.getSourceFile(file)!;
    const hs = helpers.get(file);
    if (hs?.size) fileEdits.push({ pos: importInsertPos(sf), end: importInsertPos(sf), text: helperImport(file, root, hs) });
    out.set(file, applyEdits(sf.getFullText(), fileEdits));
  }
  stats.files = out.size;
  return { files: out, errors, stats };
}

// ── Drizzle inits: schema -> relations ──────────────────────────────────────

/**
 * `drizzle({ ..., schema })` -> `relations`; `drizzle<typeof schema>` ->
 * `drizzle<typeof relations>`. v1's pg config has no `schema` key at all.
 * Handles `import * as schema from '.../schema'` and
 * `const schema = await import('.../schema')`; the static import is dropped
 * when nothing else reads `schema`.
 */
export function convertDrizzleInit(source: string): string | null {
  const staticImport = source.match(/import \* as schema from '([^']+\/schema)';/);
  const dynamicImport = source.match(/const schema = await import\('([^']+\/schema)'\);/);
  const found = staticImport ?? dynamicImport;
  if (!found) return null;
  let out = source
    .replace(/(drizzle\(\{[^{}]*?)\bschema\b(\s*[,}])/g, '$1relations$2')
    // A positional driver (pg-proxy): drizzle(callback, { schema }).
    .replace(/^(.*\bdrizzle\(.*,\s*\{\s*)schema(\s*\}\))/gm, '$1relations$2')
    .replace(/drizzle<typeof schema>/g, 'drizzle<typeof relations>');
  if (out === source) return null;
  const relSpec = found[1].replace(/schema$/, 'relations');
  const relLine = staticImport
    ? `import { relations } from '${relSpec}';`
    : `const { relations } = await import('${relSpec}');`;
  const indent = dynamicImport ? (source.slice(0, source.indexOf(found[0])).match(/[ \t]*$/)?.[0] ?? '') : '';
  out = out.replace(found[0], `${found[0]}\n${indent}${relLine}`);
  if (staticImport) {
    const sf = ts.createSourceFile('x.ts', out, ts.ScriptTarget.Latest, true);
    let uses = 0;
    const walk = (n: ts.Node) => {
      if (ts.isImportDeclaration(n)) return;
      if (ts.isIdentifier(n) && n.text === 'schema') {
        const parent = n.parent;
        // A property name (`{ schema: x }`, `a.schema`) is not a read of the import.
        const isName = (ts.isPropertyAssignment(parent) && parent.name === n) || (ts.isPropertyAccessExpression(parent) && parent.name === n);
        if (!isName) uses++;
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    if (uses === 0) out = out.replace(`${staticImport[0]}\n`, '');
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function callSiteFiles(root: string): string[] {
  const listed = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  return listed
    .filter((f) => !f.startsWith('scripts/codemods/'))
    // Loose on whitespace: a chain is often split as `db.query.tasks\n  .findMany(`.
    .filter((f) => /\.query\s*\.\s*[a-zA-Z]+\s*\.\s*find(First|Many)\b/.test(readFileSync(join(root, f), 'utf8')))
    .map((f) => resolve(root, f));
}

function createProgram(root: string, files: string[]): ts.Program {
  const configPath = join(root, 'apps/web/tsconfig.json');
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, dirname(configPath));
  return ts.createProgram({ rootNames: files, options: { ...parsed.options, noEmit: true, incremental: false } });
}

function main() {
  const root = resolve(import.meta.dir, '../..');
  const write = process.argv.includes('--write');
  const errors: string[] = [];

  const schemaPath = join(root, 'packages/core/db/schema.ts');
  const relationsPath = join(root, 'packages/core/db/relations.ts');
  const files = callSiteFiles(root);
  // Type-check against the unconverted tree: the checker resolves fragments
  // and tells callbacks from SQL values, which needs RQB v1's types intact.
  const program = createProgram(root, files);
  const calls = transformCallSites(program, files, root);
  errors.push(...calls.errors);

  const rel = convertRelations(readFileSync(schemaPath, 'utf8'));
  errors.push(...rel.errors.map((e) => `relations: ${e}`));

  const inits = new Map<string, string>();
  for (const f of execFileSync('git', ['grep', '-l', 'drizzle', '--', '*.ts', '*.tsx'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)) {
    if (f.startsWith('scripts/codemods/')) continue;
    const abs = join(root, f);
    const converted = convertDrizzleInit(calls.files.get(abs) ?? readFileSync(abs, 'utf8'));
    if (converted) inits.set(abs, converted);
  }

  console.log(`relational queries: ${JSON.stringify(calls.stats)}`);
  console.log(`relations: ${relationsPath.replace(`${root}/`, '')} (from ${schemaPath.replace(`${root}/`, '')})`);
  console.log(`drizzle inits: ${[...inits.keys()].map((f) => relative(root, f)).join(', ') || 'none'}`);
  if (errors.length) {
    console.error(`\n${errors.length} problem(s):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  if (!write) {
    console.log('\nDry run. Pass --write to rewrite the files.');
  } else {
    if (existsSync(relationsPath)) throw new Error(`${relationsPath} already exists; has the codemod run already?`);
    for (const [file, text] of calls.files) writeFileSync(file, text);
    for (const [file, text] of inits) writeFileSync(file, text);
    writeFileSync(schemaPath, rel.schema);
    writeFileSync(relationsPath, rel.relations);
    console.log(`\nWrote ${calls.files.size + inits.size + 2} files.`);
  }
  if (errors.length) process.exit(1);
}

if (import.meta.main) main();
