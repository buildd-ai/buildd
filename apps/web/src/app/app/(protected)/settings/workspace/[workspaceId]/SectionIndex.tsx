/**
 * The page's sections as in-page links (settings spec R-1). Desktop: sticky
 * above the content, so any section is one click away mid-page. Phone: a row
 * at the top that scrolls sideways. Each link jumps to its section's id.
 */
export function SectionIndex({ sections }: { sections: Array<{ id: string; label: string }> }) {
  return (
    <nav
      aria-label="Sections"
      data-testid="workspace-section-index"
      className="-mx-4 px-4 md:mx-0 md:px-0 md:sticky md:top-0 md:z-10 bg-surface-1 border-b border-border-default"
    >
      <ul className="flex gap-1 overflow-x-auto whitespace-nowrap py-1">
        {sections.map(s => (
          <li key={s.id} className="shrink-0">
            <a
              href={`#${s.id}`}
              className="inline-flex min-h-11 md:min-h-9 items-center px-2 text-sm text-text-secondary hover:text-text-primary"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
