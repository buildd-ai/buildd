'use client';

import { useCallback, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { displayWorkspaceName } from '@buildd/shared';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useEscapeClose } from '@/hooks/useEscapeClose';
import { switchTeam } from '@/lib/switch-team';
import { showsWorkspaceFilter } from '@/lib/nav-config';
import { buildWorkspaceParam } from './WorkspaceSwitcher';

interface Team {
  id: string;
  name: string;
  slug: string;
}

const option = 'flex w-full items-center gap-2 px-3 py-2 text-left text-body transition-colors hover:bg-surface-3';

/**
 * The desktop rail's one scope control, at its top: `Team · Workspace ⌄`.
 * It replaces the rail's team tile and the slim workspace bar above the page.
 * The workspace half shows only on pages that read ?workspace= (anywhere else
 * it would change the URL and nothing else). Picking a team reloads
 * (switchTeam); picking a workspace sets ?workspace= on the current page, the
 * same param the phone header's WorkspaceSwitcher writes.
 *
 * A disclosure, not an ARIA menu: plain buttons reached with Tab; Escape
 * closes it and refocuses the trigger.
 */
export default function ScopeSwitcher({
  teams,
  currentTeamId,
  workspaces = [],
}: {
  teams: Team[];
  currentTeamId: string | null;
  workspaces?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close);
  useEscapeClose(open, close, triggerRef, ref);

  const team = teams.find((t) => t.id === currentTeamId) ?? teams[0] ?? null;
  const showWorkspaces = workspaces.length > 0 && showsWorkspaceFilter(pathname);
  const selectedId = searchParams.get('workspace');
  const selected = selectedId ? workspaces.find((w) => w.id === selectedId) : null;
  const workspaceLabel = selected ? displayWorkspaceName(selected.name) : 'All workspaces';
  const multiTeam = teams.length > 1;
  if (!team && !showWorkspaces) return null;

  const pickWorkspace = (id: string | null) => {
    const qs = buildWorkspaceParam(searchParams.toString(), id);
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`);
    close();
  };
  const label = [team?.name, showWorkspaces ? workspaceLabel : null].filter(Boolean).join(' · ');

  return (
    <div ref={ref} className="relative mb-3 px-2">
      <button
        ref={triggerRef}
        type="button"
        data-testid="scope-switcher"
        onClick={() => setOpen(!open)}
        aria-label={`Scope: ${label}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="flex min-h-9 w-full min-w-0 items-center gap-1.5 px-2 text-left text-body font-semibold text-text-primary transition-colors hover:bg-surface-3"
      >
        <span className="min-w-0 flex-1">
          {team && <span className="block truncate">{team.name}</span>}
          {showWorkspaces && <span className="block truncate text-meta font-normal text-text-secondary">{workspaceLabel}</span>}
        </span>
        <span aria-hidden="true" className={`shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>

      {open && (
        <div id={panelId} className="absolute left-2 top-full z-50 mt-1 w-60 overflow-hidden border border-border-strong bg-card py-1">
          {multiTeam && (
            <div role="group" aria-label="Team">
              <p className="px-3 pb-1 pt-1.5 text-meta text-text-muted">Team</p>
              {teams.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-current={t.id === team?.id ? 'true' : undefined}
                  onClick={() => switchTeam(t.id)}
                  className={`${option} ${t.id === team?.id ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  {t.id === team?.id && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          )}
          {showWorkspaces && (
            <div role="group" aria-label="Workspace" className={multiTeam ? 'mt-1 border-t border-border-default pt-1' : ''}>
              <p className="px-3 pb-1 pt-1.5 text-meta text-text-muted">Workspace</p>
              {[{ id: null as string | null, name: 'All workspaces' }, ...workspaces.map((w) => ({ id: w.id as string | null, name: displayWorkspaceName(w.name) }))].map((w) => {
                const current = (w.id ?? null) === (selected?.id ?? null);
                return (
                  <button
                    key={w.id ?? 'all'}
                    type="button"
                    aria-current={current ? 'true' : undefined}
                    onClick={() => pickWorkspace(w.id)}
                    className={`${option} ${current ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    {current && <span aria-hidden="true">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-1 border-t border-border-default pt-1">
            <Link href="/app/workspaces" onClick={close} className={`${option} text-text-secondary`}>Manage workspaces</Link>
          </div>
        </div>
      )}
    </div>
  );
}
