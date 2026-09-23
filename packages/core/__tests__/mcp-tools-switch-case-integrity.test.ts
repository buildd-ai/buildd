/**
 * Static integrity checks on handleBuilddAction's switch(action) body.
 *
 * mcp-tools.ts had two `case 'get_task':` labels — the second (~60 lines,
 * porting worker.currentAction and a pending-task hint the first case
 * lacked) was dead code: JS takes the first match, so the switch's `break`less
 * `return` inside the first case meant the second block never ran. A runtime
 * "every advertised action is reachable" test (mcp-tools-action-coverage)
 * does not catch this class of bug — get_task WAS reachable, just via the
 * wrong (stale) implementation. This test parses the switch statement's AST
 * directly instead, which also caught `detect_projects`: described in
 * buildParamsDescription's params doc with no `case` anywhere in the
 * dispatcher, so a caller who read the params doc and called it got
 * "Unknown action: detect_projects".
 */
import { describe, it, expect } from 'bun:test';
import * as ts from 'typescript';
import { readFileSync } from 'fs';
import path from 'path';

const SOURCE_PATH = path.join(__dirname, '../mcp-tools.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');
const sourceFile = ts.createSourceFile(SOURCE_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function findFunctionByName(root: ts.Node, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  function visit(n: ts.Node) {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(root);
  return found;
}

/** First (outermost) switch statement found in a depth-first walk. */
function findOutermostSwitch(root: ts.Node): ts.SwitchStatement | undefined {
  let found: ts.SwitchStatement | undefined;
  function visit(n: ts.Node) {
    if (found) return;
    if (ts.isSwitchStatement(n)) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(root);
  return found;
}

/** Case-clause string-literal labels directly under this switch (nested switches excluded — AST-scoped, not text-scoped). */
function directCaseLabels(sw: ts.SwitchStatement): string[] {
  const labels: string[] = [];
  for (const clause of sw.caseBlock.clauses) {
    if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) {
      labels.push(clause.expression.text);
    }
  }
  return labels;
}

function findObjectLiteralVar(root: ts.Node, varName: string): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  function visit(n: ts.Node) {
    if (found) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === varName &&
      n.initializer &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      found = n.initializer;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(root);
  return found;
}

function objectLiteralKeys(obj: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = [];
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) keys.push(prop.name.text);
  }
  return keys;
}

const handleBuilddActionFn = findFunctionByName(sourceFile, 'handleBuilddAction');
if (!handleBuilddActionFn?.body) throw new Error('handleBuilddAction not found in mcp-tools.ts');

const actionSwitch = findOutermostSwitch(handleBuilddActionFn.body);
if (!actionSwitch) throw new Error('switch (action) not found in handleBuilddAction body');

const caseLabels = directCaseLabels(actionSwitch);

const buildParamsDescriptionFn = findFunctionByName(sourceFile, 'buildParamsDescription');
if (!buildParamsDescriptionFn?.body) throw new Error('buildParamsDescription not found in mcp-tools.ts');

const descriptionsObj = findObjectLiteralVar(buildParamsDescriptionFn.body, 'descriptions');
if (!descriptionsObj) throw new Error('descriptions object not found in buildParamsDescription');

const paramDescriptionKeys = objectLiteralKeys(descriptionsObj);

// Actions intercepted before ever reaching handleBuilddAction's switch, by
// both MCP transports (see mcp-tools-action-coverage.test.ts's
// KNOWN_PRE_DISPATCHED for the full reasoning) — legitimately absent here.
const PRE_DISPATCHED = new Set(['consolidate_knowledge', 'memory_delete']);

describe('handleBuilddAction switch(action) — static integrity', () => {
  it('has no duplicate case labels', () => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const label of caseLabels) (seen.has(label) ? dupes : seen).add(label);
    expect([...dupes].sort()).toEqual([]);
  });

  it('every buildParamsDescription key not pre-dispatched has a case', () => {
    const missing = paramDescriptionKeys.filter(
      k => !PRE_DISPATCHED.has(k) && !caseLabels.includes(k),
    );
    expect(missing.sort()).toEqual([]);
  });

  it('no documented action is a stray (detect_projects had a description but no case)', () => {
    expect(paramDescriptionKeys).not.toContain('detect_projects');
  });
});
