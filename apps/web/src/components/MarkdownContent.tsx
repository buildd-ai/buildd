'use client';

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
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
  /**
   * A spec revision's attachments (living-specs.md §21): what
   * `![caption](attachment:<name>)` resolves to, each a lasting buildd link.
   * A name absent here renders as a visible "missing attachment" placeholder,
   * never a broken image. Only these links load inline; any other image
   * follows `images`.
   */
  attachments?: Record<string, { src: string; alt: string | null; image: boolean }>;
}

export const ATTACHMENT_SCHEME = 'attachment:';

/** Keep `attachment:<name>` for the img renderer to resolve; every other URL gets the default sanitizing. */
export function specUrlTransform(url: string): string {
  return url.startsWith(ATTACHMENT_SCHEME) ? url : defaultUrlTransform(url);
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

export default function MarkdownContent({ content, className = '', variant = 'default', images = 'render', surface = 'default', attachments }: MarkdownContentProps) {
  const compact = variant === 'compact';
  const spec = surface === 'spec';
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none ${className}`}>
      <ReactMarkdown
        // GFM: tables, strikethrough, task lists, autolinks. Agent output leans on
        // tables; without this they rendered as raw `| a | b |` rows.
        remarkPlugins={[remarkGfm]}
        urlTransform={specUrlTransform}
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
          img: ({ node: _node, src, alt, ...rest }: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown; src?: unknown }) => {
            const url = typeof src === 'string' ? src : undefined;
            if (url?.startsWith(ATTACHMENT_SCHEME)) {
              const name = url.slice(ATTACHMENT_SCHEME.length);
              const hit = attachments && Object.hasOwn(attachments, name) ? attachments[name] : undefined;
              if (!hit) {
                return (
                  <span className="my-2 block border-l-2 border-dashed border-border-default py-1 pl-3 text-meta text-text-muted not-italic [overflow-wrap:anywhere]" data-testid="spec-attachment-missing" role="note">
                    Missing attachment: {name}{alt ? ` (${alt})` : ''}
                  </span>
                );
              }
              if (!hit.image) {
                return <a href={hit.src} className="text-primary hover:underline [overflow-wrap:anywhere]" data-testid="spec-attachment-link">{alt || hit.alt || name}</a>;
              }
              return (
                <span className="my-2 block" data-testid="spec-attachment-image">
                  {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked redirect, not a static asset */}
                  <img src={hit.src} alt={alt || hit.alt || name} loading="lazy" className="my-0 h-auto max-w-full rounded-md border border-border-default" />
                  {hit.alt || alt ? <span className="mt-1 block text-meta text-text-muted">{hit.alt || alt}</span> : null}
                </span>
              );
            }
            if (images === 'link') {
              return (
                <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="text-primary hover:underline">
                  {alt || url || 'image'}
                </a>
              );
            }
            // eslint-disable-next-line @next/next/no-img-element
            return <img {...rest} src={url} alt={alt} />;
          },
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
