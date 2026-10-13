'use client';

import { useEffect, useId, useState } from 'react';

/**
 * A ```mermaid block on a spec surface (living-specs.md §15). The library is
 * large, so it loads on the client only when a block is on the page. It runs
 * with `securityLevel: 'strict'` and no HTML labels, so diagram text cannot
 * inject markup or script. Until it has rendered, and when it fails, the
 * source shows as code; a failure also says why. The source is the spec's
 * text: nothing here changes the body, its hash or its diff.
 */

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
};

/** Overridable for tests: how the library is loaded. */
export const mermaidLoader: { load: () => Promise<MermaidApi> } = {
  load: async () => (await import('mermaid')).default as unknown as MermaidApi,
};

// The app is dark unless the root says light (app/layout.tsx themeScript, globals.css).
const isDark = () => typeof document === 'undefined' || document.documentElement.getAttribute('data-theme') !== 'light';

export default function MermaidBlock({ source }: { source: string }) {
  const rawId = useId();
  const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [state, setState] = useState<{ svg: string } | { error: string } | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const mermaid = await mermaidLoader.load();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          theme: isDark() ? 'dark' : 'default',
        });
        const { svg } = await mermaid.render(id, source);
        if (live) setState({ svg });
      } catch (err) {
        if (live) setState({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { live = false; };
  }, [id, source]);

  if (state && 'svg' in state) {
    return (
      <div
        className="my-2 max-w-full overflow-x-auto"
        data-testid="mermaid-diagram"
        role="img"
        aria-label="Diagram"
        // Rendered by mermaid with securityLevel 'strict' (sanitized SVG, no HTML labels).
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    );
  }
  return (
    <div className="my-2" data-testid={state ? 'mermaid-error' : 'mermaid-source'}>
      {state && 'error' in state ? (
        <p className="text-meta text-status-error">This diagram could not be drawn: {state.error}</p>
      ) : null}
      <pre className="bg-surface-1 text-text-primary p-3 overflow-x-auto text-sm"><code>{source}</code></pre>
    </div>
  );
}
