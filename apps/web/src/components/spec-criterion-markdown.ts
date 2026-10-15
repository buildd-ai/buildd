import type { Root, BlockContent, DefinitionContent, Paragraph, PhrasingContent } from 'mdast';
import type { Processor } from 'unified';
import { requirementIds, tableRowId } from '@buildd/spec-contract/requirements';

type Block = BlockContent | DefinitionContent;

/** Recognition and first-definition wins come exclusively from the grading parser.
 * Transform the Markdown tree, retaining ordinary Markdown nodes and inline styles.
 */
export default function specCriterionMarkdown(this: Processor) {
  const processor = this;
  return (tree: Root, file: { toString(): string }) => {
    const source = file.toString();
    const lines = source.split('\n');
    const definitions = new Map(requirementIds(source).map(ref => [ref.line, ref]));
    if (!definitions.size) return;
    const parse = (text: string) => (processor.parse(text) as Root).children as Block[];
    const criterionNodes = new WeakSet<Block>();
    const inline = (text: string): PhrasingContent[] => {
      const first = parse(text)[0];
      return first && 'children' in first ? first.children as PhrasingContent[] : [];
    };
    const criterion = (line: number, children?: PhrasingContent[]): Paragraph => {
      const ref = definitions.get(line)!;
      // Strip presentation only AFTER the shared parser identified the definition.
      const raw = lines[line - 1]!;
      const text = tableRowId(raw)?.text ?? raw.replace(/^.*?(?:R|AC|D|I)-\d+\s*(?:\*\*|__)?\s*[:.)—–-]?\s*/, '');
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
        const out: Block[] = [];
        const originalHeader = node.children[0]!;
        const headerIsCriterion = definitions.has(originalHeader.position?.start.line ?? 0);
        const header = headerIsCriterion
          ? { ...originalHeader, children: originalHeader.children.map(cell => ({ ...cell, children: [] })) }
          : originalHeader;
        let ordinary = [header];
        const flush = () => {
          if (ordinary.length > 1) out.push({ ...node, children: ordinary });
          ordinary = [header];
        };
        for (const row of node.children.slice(headerIsCriterion ? 0 : 1)) {
          const line = row.position?.start.line ?? 0;
          if (!definitions.has(line)) { ordinary.push(row); continue; }
          flush();
          const children: PhrasingContent[] = [];
          row.children.slice(1).forEach(cell => {
            if (!cell.children.length) return;
            if (children.length) children.push({ type: 'text', value: '; ' });
            children.push(...cell.children);
          });
          out.push(criterion(line, children));
        }
        flush();
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
    tree.children = tree.children.flatMap(node => transform(node as Block));
  };
}
