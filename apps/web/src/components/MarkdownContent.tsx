'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MermaidBlock from '@/components/MermaidBlock';

interface MarkdownContentProps {
  content: string;
  className?: string;
  /**
   * `compact`: headings step down to body size so a short block of prose
   * (a mission description under the masthead) never out-shouts the page
   * title. Everything else is the same renderer.
   */
  variant?: 'default' | 'compact';
  /**
   * `link`: an image renders as a link to it instead of loading. For text a
   * model wrote (chat): an auto-loading image URL would send whatever the
   * model put in it to that host with no click, so anything the model read
   * could leave through it.
   */
  images?: 'render' | 'link';
  /**
   * `spec`: a Living Spec surface (living-specs.md §15). ```mermaid blocks
   * draw as diagrams, loaded only when one is present, and tables get ruled
   * rows. Every other surface renders exactly as before.
   */
  surface?: 'default' | 'spec';
}

type HastNode = { type?: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };

/** The source of a ```mermaid block, from the `pre` element's code child; null for any other block. */
export function mermaidSource(node: HastNode | undefined): string | null {
  const code = node?.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  const cls = code?.properties?.className;
  const classes = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(/\s+/) : [];
  if (!classes.includes('language-mermaid')) return null;
  const text = (n: HastNode): string => (n.type === 'text' ? n.value ?? '' : (n.children ?? []).map(text).join(''));
  return text(code!).replace(/\n$/, '');
}

export default function MarkdownContent({ content, className = '', variant = 'default', images = 'render', surface = 'default' }: MarkdownContentProps) {
  const compact = variant === 'compact';
  const spec = surface === 'spec';
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none ${className}`}>
      <ReactMarkdown
        // GFM: tables, strikethrough, task lists, autolinks. Agent output leans on
        // tables; without this they rendered as raw `| a | b |` rows.
        remarkPlugins={[remarkGfm]}
        components={{
          // Style overrides for better integration
          h1: ({ children }) => (
            <h1 className={compact ? 'text-[14px] font-semibold text-text-primary mt-3 mb-1' : 'text-xl font-bold mt-4 mb-2'}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className={compact ? 'text-[13px] font-semibold text-text-primary mt-3 mb-1' : 'text-lg font-semibold mt-3 mb-2'}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className={compact ? 'text-[13px] font-medium text-text-primary mt-2 mb-1' : 'text-base font-medium mt-2 mb-1'}>{children}</h3>
          ),
          p: ({ children }) => <p className={compact ? 'my-1.5' : 'my-2'}>{children}</p>,
          ul: ({ children }) => <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="ml-2">{children}</li>,
          code: ({ children, className }) => {
            const isInline = !className;
            return isInline ? (
              <code className={`px-1 py-0.5 bg-surface-3 rounded font-mono [overflow-wrap:anywhere] ${compact ? 'text-[12px]' : 'text-sm'}`}>
                {children}
              </code>
            ) : (
              <code className={className}>{children}</code>
            );
          },
          pre: ({ children, node }) => {
            const diagram = spec ? mermaidSource(node as HastNode | undefined) : null;
            if (diagram !== null) return <MermaidBlock source={diagram} />;
            return (
              <pre className={`bg-surface-1 text-text-primary p-3 rounded-md overflow-x-auto my-2 ${compact ? 'text-[12px]' : 'text-sm'}`}>
                {children}
              </pre>
            );
          },
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {children}
            </a>
          ),
          ...(images === 'link' ? {
            img: ({ src, alt }: { src?: unknown; alt?: string }) => (
              <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer nofollow" className="text-primary hover:underline">
                {alt || (typeof src === 'string' ? src : 'image')}
              </a>
            ),
          } : {}),
          // A wide table scrolls inside its own box instead of widening the page.
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 max-w-full" data-testid={spec ? 'spec-table' : undefined}>
              <table className={spec ? 'my-0 w-max min-w-full border-collapse text-meta' : 'my-0'}>{children}</table>
            </div>
          ),
          ...(spec ? {
            th: ({ children }: { children?: React.ReactNode }) => (
              <th className="border border-border-default bg-surface-2 px-2 py-1 text-left align-top font-semibold text-text-primary">{children}</th>
            ),
            td: ({ children }: { children?: React.ReactNode }) => (
              <td className="border border-border-default px-2 py-1 align-top text-text-secondary">{children}</td>
            ),
            tr: ({ children }: { children?: React.ReactNode }) => <tr className="even:bg-surface-2">{children}</tr>,
          } : {}),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-border-default pl-4 my-2 italic text-text-secondary">
              {children}
            </blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
