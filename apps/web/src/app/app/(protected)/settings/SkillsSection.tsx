import Link from 'next/link';

interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  source: string | null;
  teamId: string;
}

interface Workspace {
  id: string;
  name: string;
}

const enabledBadge = 'bg-status-success/10 text-status-success';
const disabledBadge = 'bg-surface-3 text-text-secondary';

export default function SkillsSection({ skills, workspaces }: { skills: Skill[]; workspaces: Workspace[] }) {
  // Find a workspace to link to for managing skills (first one)
  const defaultWorkspace = workspaces[0];

  return (
    <section>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Skills</h2>
        {defaultWorkspace && (
          <Link
            href={`/app/workspaces/${defaultWorkspace.id}/skills`}
            className="px-3 py-1.5 text-sm border border-border-default rounded-md hover:bg-surface-3"
          >
            Manage Skills
          </Link>
        )}
      </div>

      {skills.length === 0 ? (
        <div className="border border-dashed border-border-default rounded-lg p-6 text-center">
          <p className="text-text-secondary text-sm">No team-level skills registered</p>
          <p className="text-xs text-text-muted mt-1">
            Skills are reusable agent instructions. Promote workspace skills or register via API.
          </p>
        </div>
      ) : (
        <div className="border border-border-default rounded-lg divide-y divide-border-default">
          {skills.map((skill) => (
            <div key={skill.id} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="font-medium truncate">{skill.name}</h3>
                  <code className="text-xs bg-surface-3 px-1.5 py-0.5 rounded text-text-muted flex-shrink-0">{skill.slug}</code>
                  <span className={`px-2 py-0.5 text-xs rounded-full flex-shrink-0 ${skill.enabled ? enabledBadge : disabledBadge}`}>
                    {skill.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                {skill.source && (
                  <span className="text-xs text-text-muted ml-4 flex-shrink-0">{skill.source}</span>
                )}
              </div>
              {skill.description && (
                <p className="text-sm text-text-muted mt-1 line-clamp-1">{skill.description}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
