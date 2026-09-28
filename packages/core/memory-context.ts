/**
 * The always-loaded memory context: which rows it shows and how it renders
 * them. No DB import, so read paths that only hold a searcher (mcp-tools,
 * tests that stub the database) can render it without loading the store.
 */

/** How many memories the always-loaded context shows: the most recently updated. */
export const MEMORY_CONTEXT_LIMIT = 20;

/**
 * The context markdown for rows already chosen (most recent first). Shared by
 * `getContext` and the deprecated `buildd_memory context`, which reads the same
 * rows through retrieveMemory so the use ledger sees them.
 */
export function renderMemoryContext(
  rows: ReadonlyArray<{ type: string; title: string; content: string; tags?: string[] | null }>,
): { markdown: string; count: number } {
  if (rows.length === 0) return { markdown: '', count: 0 };
  const lines = rows.map(m => {
    const meta = [
      m.type,
      m.tags?.length ? m.tags.join(', ') : null,
    ].filter(Boolean).join(' · ');
    return `## [${meta}] ${m.title}\n${m.content}`;
  });
  return { markdown: lines.join('\n\n---\n\n'), count: rows.length };
}
