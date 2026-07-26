import Link from 'next/link';

/**
 * Initiative scoping chips for the Home queues. Chips SCOPE (filter) the list —
 * they never group it. Server-rendered links driven by a `?initiative=` search
 * param (same pattern as WorkspaceFilter), so no client state. Renders nothing
 * when there are fewer than two initiatives present — a single option is not a
 * filter.
 */
export default function InitiativeFilterChips({
  initiatives,
  selectedId,
  workspaceFilter,
}: {
  initiatives: Array<{ id: string; title: string }>;
  selectedId: string | null;
  workspaceFilter: string | null;
}) {
  if (initiatives.length < 2) return null;

  const href = (id: string | null) => {
    const p = new URLSearchParams();
    if (workspaceFilter) p.set('workspace', workspaceFilter);
    if (id) p.set('initiative', id);
    const q = p.toString();
    return q ? `/app/home?${q}` : '/app/home';
  };

  const pill = (active: boolean) => `filter-pill ${active ? 'filter-pill-active' : ''}`;

  return (
    <div className="flex items-center gap-1 flex-wrap mb-3">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5 text-text-muted shrink-0 mr-0.5" aria-hidden>
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
      </svg>
      <Link href={href(null)} className={pill(!selectedId)}>All</Link>
      {initiatives.map((i) => (
        <Link key={i.id} href={href(i.id)} className={`${pill(selectedId === i.id)} max-w-[160px] truncate`} title={i.title}>
          {i.title}
        </Link>
      ))}
    </div>
  );
}
