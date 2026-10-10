import Link from 'next/link';
import Section from '@/components/ui/Section';

export interface TurnedOffRole {
  id: string;
  slug: string;
  name: string;
  /** "Team", or the workspace it belongs to. */
  scopeLabel: string;
}

/**
 * Roles that take no new tasks. Listed so they stay findable; the editor is
 * where one is turned back on.
 */
export function TurnedOffRoles({ roles }: { roles: TurnedOffRole[] }) {
  if (roles.length === 0) return null;
  return (
    <Section title="Turned off" count={roles.length} className="mt-8">
      <ul className="divide-y divide-border-default border-y border-border-default">
        {roles.map(r => (
          <li key={r.id}>
            <Link
              href={`/app/settings/roles/${encodeURIComponent(r.slug)}/edit?id=${encodeURIComponent(r.id)}`}
              className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate text-text-primary">{r.name}</span>
              <span className="shrink-0 text-text-muted">{r.scopeLabel}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
