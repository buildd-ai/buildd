import type { ReactNode } from 'react';
import Chip from '@/components/ui/Chip';
import { criterionWords, type CriterionMark } from '@/lib/specs/delivery-words';
import type { Root, BlockContent, DefinitionContent, Paragraph, PhrasingContent } from 'mdast';
import type { Processor } from 'unified';
import { requirementIds, tableRowId } from '@buildd/spec-contract/requirements';

type Block = BlockContent | DefinitionContent;

/** Recognition and first-definition wins come exclusively from the grading parser.
 * Transform the Markdown tree, retaining ordinary Markdown nodes and inline styles.
 */
export function specCriterionMarkdown(this: Processor) {
  const processor = this;
  return (tree: Root, file: { toString(): string }) => {
    const source = file.toString();
    const lines = source.split('\n');
    const definitions = new Map(requirementIds(source).map(ref => [ref.line, ref]));
    if (!definitions.size) return;
    // A fragment parser only recognizes reference syntax when its definitions
    // are present. Keep the document's definitions available to every fragment.
    const references: DefinitionContent[] = [];
    const collect = (node: Root | Block) => {
      if (node.type === 'definition') references.push(node);
      if ('children' in node) {
        for (const child of node.children) collect(child as Block);
      }
    };
    collect(tree);
    const referenceSource = references.map(node =>
      source.slice(node.position!.start.offset, node.position!.end.offset)
    ).join('\n');
    const parse = (text: string) => (processor.parse(`${text}\n\n${referenceSource}`) as Root)
      .children.filter(node => node.type !== 'definition') as Block[];
    const criterionNodes = new WeakSet<Block>();
    const inline = (text: string): PhrasingContent[] => {
      const first = parse(text)[0];
      return first && 'children' in first ? first.children as PhrasingContent[] : [];
    };
    const criterion = (line: number, children?: PhrasingContent[]): Paragraph => {
      const ref = definitions.get(line)!;
      // Strip presentation only AFTER the shared parser identified the definition.
      const raw = lines[line - 1]!;
      const text = tableRowId(raw)?.text ?? raw.replace(/^.*?(?:R|AC|D|I)-\d+\s*(?:\*\*|__)?\s*[:.)\u2014\u2013-]?\s*/, '');
      const node: Paragraph = {
        type: 'paragraph', children: children ?? inline(text),
        data: { hName: 'div', hProperties: { 'data-criterion-id': ref.id } },
      };
      criterionNodes.add(node);
      return node;
    };
    const transform = (node: Block): Block[] => {
      const start = node.position?.start.line ?? 0;
      const end = node.position?.end.line ?? 0;
      const hits = [...definitions.keys()].filter(line => line >= start && line <= end);
      if (!hits.length) return [node];
      if (node.type === 'table') {
        const headerIsCriterion = definitions.has(node.children[0]?.position?.start.line ?? 0);
        if (!headerIsCriterion) {
          return [{ ...node, children: node.children.map((row, index) => {
            const line = row.position?.start.line ?? 0;
            if (index === 0 || !definitions.has(line)) return row;
            const children: PhrasingContent[] = [];
            row.children.slice(1).forEach(cell => {
              if (!cell.children.length) return;
              if (children.length) children.push({ type: 'text', value: '; ' });
              children.push(...cell.children);
            });
            return { ...row, children: [{
              type: 'tableCell' as const,
              data: { hProperties: { colSpan: row.children.length } },
              // mdast-to-hast supports flow content in the generated table cell.
              children: [criterion(line, children)] as unknown as PhrasingContent[],
            }] };
          }) }];
        }
        const out: Block[] = [];
        const ordinary = node.children.filter(row => !definitions.has(row.position?.start.line ?? 0));
        for (const row of node.children) {
          const line = row.position?.start.line ?? 0;
          if (definitions.has(line)) out.push(criterion(line, row.children.slice(1).flatMap(cell => cell.children)));
        }
        if (ordinary.length) out.push({ ...node, children: [
          { ...node.children[0]!, children: node.children[0]!.children.map(cell => ({ ...cell, children: [] })) },
          ...ordinary,
        ] });
        return out;
      }
      if (node.type === 'list') {
        const out: Block[] = [];
        let ordinary: typeof node.children = [];
        let index = 0;
        const flush = () => {
          if (ordinary.length) out.push({ ...node, start: node.ordered ? (node.start ?? 1) + index - ordinary.length : node.start, children: ordinary });
          ordinary = [];
        };
        for (const item of node.children) {
          const changed = item.children.flatMap(child => transform(child));
          if (changed.some(child => criterionNodes.has(child))) {
            flush();
            out.push(...changed);
          } else ordinary.push(item);
          index++;
        }
        flush();
        return out;
      }
      if (node.type === 'blockquote') return [{ ...node, children: node.children.flatMap(child => transform(child)) }];
      // Even indented code or hidden wrappers can define ids in the shared parser.
      const out: Block[] = [];
      let from = start;
      for (const line of hits) {
        if (line > from) out.push(...parse(lines.slice(from - 1, line - 1).join('\n')));
        out.push(criterion(line));
        from = line + 1;
      }
      if (from <= end) out.push(...parse(lines.slice(from - 1, end).join('\n')));
      return out;
    };
    tree.children = [...tree.children.flatMap(node => transform(node as Block)), ...references];
  };
}

/** One anchored L1 criterion row, shared by plain and table definitions. */
export default function SpecCriteriaBody({ id, children, criterionVerdicts }: {
  id: string;
  children: ReactNode;
  criterionVerdicts: Array<{ criterionId: string; mark: CriterionMark; title: string; href: string }>;
}) {
            return (
              <div id={id} data-testid="spec-criterion" className="not-prose flex scroll-mt-6 items-start gap-3 py-3 [&+div[data-testid=spec-criterion]]:border-t [&+div[data-testid=spec-criterion]]:border-[var(--line-soft)]">
                <div className="flex max-w-32 shrink-0 flex-col items-start gap-1">
                  <a href={`#${id}`} aria-label={`Link to ${id}`} className="inline-flex min-h-11 items-center text-text-primary hover:underline md:min-h-0">
                    <Chip tone="muted" dot={false}>{id}</Chip>
                  </a>
                  {criterionVerdicts.filter(v => v.criterionId === id).map(v => (
                    <a key={v.href} href={v.href} title={v.title} data-testid="spec-criterion-verdict" className="inline-flex min-h-11 items-center text-meta text-text-secondary underline md:min-h-0">{criterionWords(v.mark).label}</a>
                  ))}
                </div>
                <div className="min-w-0 text-body text-text-primary [overflow-wrap:anywhere]">{children}</div>
              </div>
            );
}
