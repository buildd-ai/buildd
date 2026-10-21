import * as ts from 'typescript';
import type { ChangedSubject } from './pipeline';

export interface StaticCopyContext {
  container: string;
  heading?: string;
  nearbyText: string[];
  completeness: 'static-partial';
}

type Element = ts.JsxElement | ts.JsxSelfClosingElement;
const isElement = (node: ts.Node): node is Element => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
const opening = (node: Element) => ts.isJsxElement(node) ? node.openingElement : node;
const tag = (node: Element) => opening(node).tagName.getText();
const native = (node: Element) => /^[a-z][a-z0-9]*$/.test(tag(node));
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Conservative static exclusions, not a claim to compute CSS or runtime visibility. */
function unavailable(node: Element): boolean {
  if (!native(node) || /^(script|style|template)$/.test(tag(node))) return true;
  for (const attr of opening(node).attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) return true;
    const name = attr.name.getText();
    const value = attr.initializer;
    if (name === 'hidden') {
      if (value && ts.isJsxExpression(value) && value.expression?.kind === ts.SyntaxKind.FalseKeyword) continue;
      return true;
    }
    if (name === 'aria-hidden') {
      if (value && ts.isStringLiteral(value) && value.text === 'false') continue;
      if (value && ts.isJsxExpression(value) && value.expression?.kind === ts.SyntaxKind.FalseKeyword) continue;
      return true;
    }
    if (name === 'className') {
      if (!value || !ts.isStringLiteral(value)) return true;
      if (/(?:^|\s)(?:[\w-]+:)*(?:hidden|invisible|sr-only)(?:\s|$)/.test(value.text)) return true;
    }
    // Inline style can hide content; resolving its expression is outside this adapter.
    if (name === 'style') return true;
  }
  return false;
}

/** Preserve inline sentence order. Any unknown part invalidates the complete sibling. */
function staticText(node: ts.Node): string | null {
  if (ts.isJsxText(node)) {
    // Avoid changing entity meaning without a complete JSX entity decoder.
    return /&(?:#\w+|[a-z]+);/i.test(node.text) ? null : node.text;
  }
  if (ts.isJsxExpression(node)) {
    if (!node.expression) return ''; // JSX comments contain no rendered text.
    return ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)
      ? node.expression.text : null;
  }
  if (!isElement(node) || unavailable(node) || !ts.isJsxElement(node)) return null;
  // Text in a nested card/container is not a neighboring sentence.
  if (/^(section|article|div|main|nav|aside|form|fieldset|ul|ol|table)$/.test(tag(node))) return null;
  const pieces = node.children.map(staticText);
  return pieces.some(piece => piece === null) ? null : pieces.join('');
}

/** Bounded local hints only; never a rendered-surface or state assertion. */
export function staticCopyContexts(file: string, content: string, subjects: readonly ChangedSubject[]): Map<number, StaticCopyContext> {
  const result = new Map<number, StaticCopyContext>();
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) return result;
  const elements: Element[] = [];
  const visit = (node: ts.Node) => {
    if (isElement(node)) elements.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const subject of subjects) {
    if (subject.file.replace(/\\/g, '/') !== file.replace(/\\/g, '/')) continue;
    const owner = elements.filter(node => node.getStart(source) <= subject.start && node.end >= subject.end)
      .sort((a, b) => (a.end - a.pos) - (b.end - b.pos))[0];
    if (!owner || unavailable(owner)) continue;
    let parent: ts.Node | undefined = owner.parent;
    while (parent && !isElement(parent)) parent = parent.parent;
    if (!parent || !ts.isJsxElement(parent) || unavailable(parent) || tag(parent).length > 80) continue;
    // A hidden or custom ancestor makes the visibility contract unavailable.
    let unsafe = false;
    for (let ancestor: ts.Node | undefined = parent.parent; ancestor; ancestor = ancestor.parent) {
      if (isElement(ancestor) && unavailable(ancestor)) { unsafe = true; break; }
    }
    if (unsafe) continue;
    const targetIndex = parent.children.findIndex(child => child.pos <= owner.pos && child.end >= owner.end);
    const candidates = parent.children.flatMap((child, index) => {
      if (index === targetIndex) return [];
      const raw = staticText(child);
      if (raw === null || !normalize(raw)) return [];
      return [{ index, text: normalize(raw), heading: isElement(child) && /^h[1-6]$/.test(tag(child)) }];
    });
    const headingNode = parent.children.slice(0, targetIndex)
      .filter(child => isElement(child) && /^h[1-6]$/.test(tag(child))).at(-1);
    const headingRaw = headingNode ? staticText(headingNode) : null;
    const heading = headingRaw !== null && normalize(headingRaw).length <= 120 ? normalize(headingRaw) || undefined : undefined;
    const nearbyText = candidates.filter(candidate => !candidate.heading && candidate.text.length <= 160)
      .sort((a, b) => Math.abs(a.index - targetIndex) - Math.abs(b.index - targetIndex) || a.index - b.index)
      .slice(0, 2).sort((a, b) => a.index - b.index).map(candidate => candidate.text);
    result.set(subject.start, { container: tag(parent), ...(heading ? { heading } : {}), nearbyText, completeness: 'static-partial' });
  }
  return result;
}
