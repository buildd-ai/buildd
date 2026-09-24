'use client';

import ReactMarkdown from 'react-markdown';

interface MarkdownContentProps {
  content: string;
  className?: string;
  /**
   * `compact`: headings step down to body size so a short block of prose
   * (a mission description under the masthead) never out-shouts the page
   * title. Everything else is the same renderer.
   */
  variant?: 'default' | 'compact';
}

export default function MarkdownContent({ content, className = '', variant = 'default' }: MarkdownContentProps) {
  const compact = variant === 'compact';
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none ${className}`}>
      <ReactMarkdown
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
              <code className={`px-1 py-0.5 bg-surface-3 rounded font-mono ${compact ? 'text-[12px]' : 'text-sm'}`}>
                {children}
              </code>
            ) : (
              <code className={className}>{children}</code>
            );
          },
          pre: ({ children }) => (
            <pre className={`bg-surface-1 text-text-primary p-3 rounded-md overflow-x-auto my-2 ${compact ? 'text-[12px]' : 'text-sm'}`}>
              {children}
            </pre>
          ),
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
