'use client';

/**
 * `?state=team-members&viewer=owner|admin|member`: the team detail page's
 * member list seen by each role (team-members-fixtures.ts). Wrapped like
 * the old team detail page so the capture keeps a page's width.
 */
import { useEffect, useState } from 'react';
import TeamDetailClient from '../../(protected)/settings/team/TeamDetailClient';
import {
  parseTeamMembersViewer,
  teamMembersFixtureLinks,
  teamMembersFixtureProps,
  type TeamMembersFixtureViewer,
} from './team-members-fixtures';

export default function TeamMembersFixture() {
  // Read the URL after mount so server and client render alike.
  const [viewer, setViewer] = useState<TeamMembersFixtureViewer | null>(null);
  useEffect(() => {
    setViewer(parseTeamMembersViewer(new URLSearchParams(window.location.search)));
  }, []);
  if (!viewer) return <div className="min-h-screen bg-surface-1" />;

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <nav aria-label="Fixture viewers" className="mb-6 flex flex-wrap gap-1.5">
          {teamMembersFixtureLinks().map((l) => (
            <a
              key={l.href}
              href={l.href}
              aria-current={l.label === `as ${viewer}` ? 'page' : undefined}
              className="border border-border-default bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-text-secondary hover:border-border-strong hover:text-text-primary aria-[current=page]:border-border-strong aria-[current=page]:text-text-primary"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <TeamDetailClient key={viewer} {...teamMembersFixtureProps(viewer)} />
      </div>
    </main>
  );
}
