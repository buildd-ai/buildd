import Link from 'next/link';

interface Workspace {
  id: string;
  name: string;
}

export default function SkillsSection({ workspaces }: { workspaces: Workspace[] }) {
  return (
    <section>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Skills</h2>
      </div>

      <div className="border border-dashed border-border-default rounded-lg p-6 text-center">
        <p className="text-text-secondary text-sm">Skills are managed per workspace</p>
        <p className="text-xs text-text-muted mt-1">
          Skills are reusable agent instructions (SKILL.md files) that give workers domain-specific expertise.
        </p>
        {workspaces.length > 0 ? (
          <div className="mt-4 space-y-2">
            {workspaces.map((ws) => (
              <Link
                key={ws.id}
                href={`/app/workspaces/${ws.id}/skills`}
                className="block px-3 py-2 text-sm border border-border-default rounded-md hover:bg-surface-3"
              >
                {ws.name} — Manage Skills
              </Link>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3 mt-3">
            <a
              href="https://docs.buildd.dev/docs/features/skills"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-sm border border-border-default rounded-md hover:bg-surface-3 text-text-secondary"
            >
              Read the docs
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
