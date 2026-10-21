import * as ts from 'typescript';
import { createHash } from 'node:crypto';
import { copyViolations } from '../../packages/core/copy-rules';
import { bannedWordsIn, findTerm, type InternalRef } from '../../packages/shared/src/terms';
import { runVerificationCheck, type VerificationResult } from '../../packages/core/verification-check';

export type CopyRole = 'status' | 'action' | 'heading' | 'description' | 'diagnostic' | 'unknown';
export interface ChangedSubject {
  kind: 'ui.copy'; file: string; line: number; endLine: number; start: number; end: number;
  before: string | null; after: string | null; component: string; prop: string;
  role: CopyRole; confidence: 'syntactic' | 'unknown'; provenance: string;
}
export interface SubjectContext {
  source: string; role?: CopyRole; purpose?: string; state?: InternalRef;
  scheduledAt?: string; action?: 'approval'; prop?: string; component?: string; start?: number;
}
export interface ProjectPolicy {
  id: string; version: number;
  authority: { title: string; revision: number; hash: string; criteria: string[]; repoGuide: string };
  selectors: { kind: string; extension: string };
  deterministic: { copyRules: boolean; termsCatalog: boolean; stateLabels: boolean };
  semantic: { mode: string; requiredEvidence: string[]; instructions: string; labels: Record<string, string>;
    sortCaption: { purpose: string; pattern: string; message: string; correction: string } };
  enforcement: { authoring: string; commit: string; pr: string };
  customRules: Array<{ id: string; roles: string[]; pattern: string; correction: string; pathPrefix?: string; component?: string }>;
}
export interface PolicyFinding {
  policy: string; policyVersion: number; rule: string; subject: ChangedSubject;
  verdict: 'pass' | 'revise' | 'uncertain' | 'unsupported'; reasonCode: string; message: string;
  suggestedCorrection?: string; evaluator: 'deterministic' | 'heuristic-advisory' | 'unavailable';
  enforced: boolean; inputFingerprint: string; verification: VerificationResult;
}

const excluded = /(^|\/)(?:api|__tests__|tests?|fixtures?|stories)\/|\.(?:test|spec|stories|fixtures?)\.tsx$/;
const visibleProps = new Set(['title', 'aria-label', 'aria-description', 'placeholder', 'alt', 'label', 'description', 'buttonLabel']);
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Parse full snapshots, not standalone patch hunks: syntax/visibility needs parent context. */
function subjects(file: string, content: string): ChangedSubject[] {
  if (!file.endsWith('.tsx') || excluded.test(file)) return [];
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diagnostics = (sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error(`Cannot parse TSX: ${file}`);
  const out: ChangedSubject[] = [];
  const add = (n: ts.Node, text: string | null, component: string, prop: string, role: CopyRole) => {
    const start = n.getStart(sf), end = n.end;
    if (text !== null && !normalize(text)) return;
    out.push({ kind: 'ui.copy', file, line: sf.getLineAndCharacterOfPosition(start).line + 1,
      endLine: sf.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1, start, end,
      before: null, after: text === null ? null : normalize(text), component, prop,
      role: text === null ? 'unknown' : role, confidence: text === null ? 'unknown' : 'syntactic',
      provenance: `typescript-jsx:${prop}` });
  };
  const literal = (n: ts.Expression | undefined): string | null => {
    if (!n) return null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    return null;
  };
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) && /^(script|style)$/.test(n.openingElement.tagName.getText(sf))) return;
    if (ts.isJsxFragment(n)) {
      for (const child of n.children) {
        if (ts.isJsxText(child)) add(child, child.text, 'Fragment', 'children', 'unknown');
        else if (ts.isJsxExpression(child) && child.expression) add(child, literal(child.expression), 'Fragment', 'children', 'unknown');
      }
    }
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      const component = opening.tagName.getText(sf);
      // Roles are syntactic hints, never evidence of state or action semantics.
      const role: CopyRole = /^(button|Button)$/.test(component) ? 'action'
        : /^h[1-6]$/.test(component) ? 'heading' : /^(p|span|label)$/.test(component) ? 'description' : 'unknown';
      for (const attr of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || !visibleProps.has(attr.name.getText(sf))) continue;
        const prop = attr.name.getText(sf);
        const native = /^[a-z]/.test(component);
        if (native && !['title', 'aria-label', 'aria-description'].includes(prop)
          && !(prop === 'placeholder' && /^(input|textarea)$/.test(component))
          && !(prop === 'alt' && /^(img|area|input)$/.test(component))
          && !(prop === 'label' && /^(option|optgroup)$/.test(component))) continue;
        const init = attr.initializer;
        const text = init && ts.isStringLiteral(init) ? init.text
          : init && ts.isJsxExpression(init) ? literal(init.expression) : null;
        add(attr, text, component, prop, prop === 'buttonLabel' ? 'action' : native && role === 'unknown' ? 'description' : role);
      }
      if (ts.isJsxElement(n)) for (const child of n.children) {
        if (ts.isJsxText(child)) add(child, child.text, component, 'children', role);
        else if (ts.isJsxExpression(child) && child.expression) add(child, literal(child.expression), component, 'children', role);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function extractChangedSubjects(input: { file: string; before: string; after: string; patch?: string }): ChangedSubject[] {
  const file = input.file.replace(/\\/g, '/');
  const previous = subjects(file, input.before);
  const next = subjects(file, input.after);
  let added: Set<number> | undefined;
  if (input.patch !== undefined) {
    added = new Set<number>();
    let line = 0, inHunk = false, expected = 0, seen = 0;
    const sourceLines = input.after.split(/\r?\n/);
    const finishHunk = () => { if (inHunk && seen !== expected) throw new Error('Patch hunk is incomplete.'); };
    for (const raw of input.patch.split(/\r?\n/)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (hunk) { finishHunk(); line = Number(hunk[1]); expected = Number(hunk[2] ?? 1); seen = 0; inHunk = true; continue; }
      if (!inHunk) continue;
      if (raw.startsWith('+') || raw.startsWith(' ')) {
        if (line < 1 || line > sourceLines.length || sourceLines[line - 1] !== raw.slice(1)) throw new Error('Patch does not match the new source snapshot.');
        if (raw.startsWith('+')) added.add(line);
        line++; seen++;
      }
    }
    finishHunk();
    if (!inHunk && input.before !== input.after) throw new Error('Changed snapshots require a valid patch hunk when patch is supplied.');
  }
  // Pair by syntactic location/order, retaining uncertain provenance for dynamics.
  const counts = new Map<string, number>();
  return next.flatMap(s => {
    const key = `${s.component}:${s.prop}`;
    const ordinal = counts.get(key) ?? 0; counts.set(key, ordinal + 1);
    const old = previous.filter(p => p.component === s.component && p.prop === s.prop)[ordinal];
    if (added && ![...added].some(l => l >= s.line && l <= s.endLine)) return [];
    if (old && s.after !== null && old.after === s.after) return [];
    return [{ ...s, before: old?.after ?? null }];
  });
}

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Local only: no model transport, env-key discovery, network, or evidence writes. */
export async function evaluateSubject(subject: ChangedSubject, policy: ProjectPolicy, context?: SubjectContext): Promise<PolicyFinding[]> {
  if (subject.kind !== policy.selectors.kind || !subject.file.endsWith(policy.selectors.extension)) return [];
  const role = context?.role ?? subject.role;
  const findings: PolicyFinding[] = [];
  const inputFingerprint = fingerprint({ subject, policy, context });
  const emit = (rule: string, verdict: PolicyFinding['verdict'], reasonCode: string, message: string,
    suggestedCorrection?: string, evaluator: PolicyFinding['evaluator'] = 'deterministic') => {
    const enforced = evaluator === 'deterministic' && verdict === 'revise';
    const mapped = { pass: 'pass', revise: 'fail', uncertain: 'inconclusive', unsupported: 'unsupported' } as const;
    const verification = runVerificationCheck({ id: `${policy.id}.${rule}`, version: policy.version,
      invariant: message, subject: { kind: subject.kind, ref: `${subject.file}:${subject.line}:${subject.start}` },
      provenance: { flavor: 'project-policy-local', origin: `${policy.authority.title}@r${policy.authority.revision}` },
      defaultSeverity: 'low', evidenceRequirements: [{ key: 'source', need: 'complete' }],
      executor: { kind: evaluator, requires: verdict === 'unsupported' ? ['authorized-semantic-model'] : [],
        run: () => ({ verdict: mapped[verdict], observed: message,
          signatureParts: [inputFingerprint], evidenceRefs: [{ kind: 'source', ref: `${subject.file}:${subject.line}` },
            { kind: 'policy', ref: `${policy.id}@${policy.version}:${policy.authority.hash}` }] }) } },
    { input: subject, capabilities: [], evidence: { source: 'complete' }, now: new Date() });
    findings.push({ policy: policy.id, policyVersion: policy.version, rule, subject, verdict,
      reasonCode, message, suggestedCorrection, evaluator, enforced, inputFingerprint, verification });
  };
  if (subject.after === null) {
    emit('visibility', 'uncertain', 'dynamic-copy', 'Resolve the runtime copy and state before evaluating it.');
    return findings;
  }
  if (role === 'unknown') {
    emit('visibility', 'uncertain', 'unknown-role', 'Supply the component contract; visibility or purpose is unknown.');
    return findings;
  }
  if (policy.deterministic.copyRules) for (const rule of copyViolations(subject.after)) {
    if (!rule.fileLevel && rule.id !== 'catalog-word') emit(rule.id, 'revise', rule.id, rule.why,
      `Apply ${rule.name}. Preserve the verified state and action meaning; the rule's examples are not literal replacements.`);
  }
  if (policy.deterministic.termsCatalog) for (const banned of bannedWordsIn(subject.after)) {
    emit('catalog-word', 'revise', 'retired-term', banned.why, banned.use);
  }
  for (const rule of policy.customRules) {
    if (rule.roles.includes(role) && (!rule.pathPrefix || subject.file.startsWith(rule.pathPrefix))
      && (!rule.component || rule.component === subject.component) && new RegExp(rule.pattern, 'i').test(subject.after)) {
      emit(rule.id, 'revise', 'workspace-rule', `Workspace policy ${rule.id} requires a correction.`, rule.correction);
    }
  }
  if (role === 'status' && policy.deterministic.stateLabels) {
    const term = context?.state ? findTerm(context.state) : undefined;
    if (!term) emit('state-label', 'uncertain', 'missing-state-context', 'Supply an authoritative projection reference; do not infer state from copy.');
    else if (subject.after !== term.word) emit('state-label', 'revise', 'state-label-mismatch', `The supplied projection maps to ${term.word}.`, term.word);
    else if (term.key === 'wait.scheduled' && (!context?.scheduledAt || !Number.isFinite(Date.parse(context.scheduledAt)))) {
      emit('state-label', 'uncertain', 'missing-schedule-date', 'Verify and show the actual scheduled date.');
    } else emit('state-label', 'pass', 'catalog-consistent', 'The label agrees with the supplied canonical projection.');
  }
  const caption = policy.semantic.sortCaption;
  if (context?.purpose === caption.purpose && new RegExp(caption.pattern, 'i').test(subject.after)) {
    emit('semantic-value', 'revise', 'redundant-sort-narration', caption.message, caption.correction, 'heuristic-advisory');
  } else {
    emit('semantic-value', 'unsupported', 'model-not-exercised', 'No authorized local semantic decision route is configured.', undefined, 'unavailable');
  }
  if (!findings.some(f => f.enforced)) emit('deterministic-rules', 'pass', 'deterministic-only', 'Applicable deterministic rules passed; semantic coverage is reported separately.');
  return findings;
}

export const policyExitCode = (findings: readonly PolicyFinding[]) => findings.some(f => f.enforced) ? 1 : 0;
