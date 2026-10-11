'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Section from '@/components/ui/Section';
import Segmented from '@/components/ui/Segmented';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { Select } from '@/components/ui/Select';
import { BackendSelect, type BackendValue } from '@/components/ui/BackendSelect';
import { ModelPicker } from '@/components/ModelPicker';
import { SUBAGENT_TOOLS_LABEL, SUBAGENT_TOOLS_NOTE } from '@/lib/role-tool-scope';
import { ColorSwatches, ROLE_COLOR_VALUES } from '@/components/ColorSwatches';
import { newRoleRequestBody, responseErrorMessage, type NewRoleKind } from '@/lib/personal-roles-shared';

const AVAILABLE_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'Agent', 'NotebookEdit',
];

interface WorkspaceOption {
  id: string;
  name: string;
}

interface Props {
  teamId: string;
  workspaces: WorkspaceOption[];
  /**
   * Kinds the viewer may create: 'personal' ("Just for me",
   * create_personal_roles) and/or 'team' (manage_agent_roles). Default team only.
   */
  kinds?: readonly NewRoleKind[];
  initialKind?: NewRoleKind;
}

const KIND_LABEL: Record<NewRoleKind, string> = {
  personal: 'Just for me',
  team: 'Team role',
};

const KIND_NOTE: Record<NewRoleKind, string> = {
  personal: 'Only your tasks can run it. You can share it with the team later.',
  team: 'Anyone in the team can run it.',
};

type Scope = 'team' | 'workspace';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function TeamRoleForm({ teamId, workspaces, kinds = ['team'], initialKind }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Who the role is for. A personal role is always team-level, so it has no scope.
  const [kind, setKind] = useState<NewRoleKind>(initialKind ?? kinds[0] ?? 'team');

  // Scope
  const [scope, setScope] = useState<Scope>('team');
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string>(workspaces[0]?.id || '');

  // Role fields
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManual, setSlugManual] = useState(false);
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [model, setModel] = useState('inherit');
  const [defaultBackend, setDefaultBackend] = useState<BackendValue>(null);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [canDelegateTo, setCanDelegateTo] = useState<string[]>([]);
  const [background, setBackground] = useState(false);
  const [maxTurns, setMaxTurns] = useState('');
  const [color, setColor] = useState(ROLE_COLOR_VALUES[Math.floor(Math.random() * ROLE_COLOR_VALUES.length)]);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugManual) setSlug(slugify(value));
  }

  const toggleTool = (tool: string) => {
    setAllowedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      let res: Response;

      if (kind === 'personal' || scope === 'team') {
        // A team-level role: the team's, or one just for the caller.
        res = await fetch('/api/roles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newRoleRequestBody(kind, teamId, {
            name,
            slug: slug || undefined,
            description: description || undefined,
            content,
            model,
            defaultBackend,
            allowedTools,
            canDelegateTo,
            background,
            maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
            color,
          })),
        });
      } else {
        // Create a workspace-scoped role
        if (!targetWorkspaceId) throw new Error('Select a workspace');
        res = await fetch(`/api/workspaces/${targetWorkspaceId}/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            slug: slug || undefined,
            description: description || undefined,
            content,
            model,
            defaultBackend,
            allowedTools,
            canDelegateTo,
            background,
            maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
            color,
            isRole: true,
          }),
        });
      }

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(responseErrorMessage(data, 'Failed to create role'));
      }

      router.push('/app/settings/roles');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create role');
    } finally {
      setSaving(false);
    }
  }

  const input = 'w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary text-base md:text-sm';
  const label = 'mb-1.5 block text-sm font-medium text-text-primary';

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Who it is for: only when the viewer may create both kinds */}
      {kinds.length > 1 ? (
        <Section title="Who uses it">
          <div className="space-y-2" data-testid="role-kind-picker">
            <Segmented
              label="Who uses it"
              items={kinds.map(k => ({ value: k, label: KIND_LABEL[k] }))}
              value={kind}
              onChange={setKind}
            />
            <p className="text-sm text-text-muted">{KIND_NOTE[kind]}</p>
          </div>
        </Section>
      ) : kind === 'personal' ? (
        <p className="text-sm text-text-muted" data-testid="role-kind-personal-note">{KIND_NOTE.personal}</p>
      ) : null}

      {/* Scope selector (team roles only) */}
      {kind === 'team' && (
        <Section title="Applies to">
          <div className="space-y-2">
            {workspaces.length > 0 ? (
              <Segmented
                label="Applies to"
                items={[
                  { value: 'team', label: 'All workspaces in team' },
                  { value: 'workspace', label: 'One workspace' },
                ]}
                value={scope}
                onChange={setScope}
              />
            ) : (
              <p className="text-sm font-medium text-text-primary">All workspaces in team</p>
            )}

            {scope === 'team' && (
              <p className="text-sm text-text-muted">
                Every workspace in your team gets this role by default. A workspace can add an override.
              </p>
            )}

            {scope === 'workspace' && workspaces.length > 0 && (
              <>
                <Select
                  value={targetWorkspaceId}
                  onChange={setTargetWorkspaceId}
                  options={workspaces.map(w => ({ value: w.id, label: w.name }))}
                  size="sm"
                />
                <p className="text-sm text-text-muted">Only the selected workspace gets this role.</p>
              </>
            )}
          </div>
        </Section>
      )}

      <Section title="Role">
        <div className="space-y-5">
          <div>
            <label htmlFor="new-role-name" className={label}>Name</label>
            <input
              id="new-role-name"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              className={input}
              placeholder="Builder"
              required
            />
          </div>

          <div>
            <label htmlFor="new-role-slug" className={label}>Slug</label>
            <input
              id="new-role-slug"
              type="text"
              value={slug}
              onChange={(e) => { setSlugManual(true); setSlug(e.target.value); }}
              className={`${input} font-mono`}
              placeholder="builder"
              pattern="^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
            />
            <p className="mt-1 text-sm text-text-muted">Auto-generated from name.</p>
          </div>

          <div>
            <label htmlFor="new-role-goal" className={label}>Goal</label>
            <input
              id="new-role-goal"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={input}
              placeholder="Ship high-quality code"
            />
          </div>

          <div>
            <label htmlFor="new-role-instructions" className={label}>Instructions</label>
            <textarea
              id="new-role-instructions"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
              className={`${input} font-mono`}
              placeholder="You are Builder, a senior software engineer…"
              required
            />
            <p className="mt-1 text-sm text-text-muted">This becomes the agent&apos;s system prompt.</p>
          </div>
        </div>
      </Section>

      <Section title="How it runs">
        <div className="space-y-6">
          <div>
            <span className={label}>Model</span>
            <ModelPicker value={model} onChange={setModel} />
          </div>

          <div>
            <span className={label}>Agent backend</span>
            <BackendSelect value={defaultBackend} onChange={setDefaultBackend} inheritLabel="Inherit" />
          </div>

          <div>
            <span className={label}>
              {SUBAGENT_TOOLS_LABEL}
              <span className="ml-1 font-mono font-normal text-text-muted">
                {allowedTools.length === 0 ? '(defaults)' : `(${allowedTools.length})`}
              </span>
            </span>
            <div className="flex flex-wrap gap-1.5">
              {AVAILABLE_TOOLS.map(tool => {
                const active = allowedTools.includes(tool);
                return (
                  <button
                    key={tool}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleTool(tool)}
                    className={`btn btn-sm h-11 md:h-6 font-mono ${active ? 'bg-[var(--q-tint)] text-text-primary font-semibold' : 'text-text-muted'}`}
                  >
                    {tool}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-sm text-text-muted">{SUBAGENT_TOOLS_NOTE}</p>
          </div>

          <div className="divide-y divide-border-default border-y border-border-default">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 py-2">
              <input
                type="checkbox"
                checked={background}
                onChange={(e) => setBackground(e.target.checked)}
                className="rounded border-border-default"
              />
              <span className="text-sm text-text-primary">Background execution</span>
            </label>
            <label className="flex min-h-11 items-center justify-between gap-2 py-2">
              <span className="text-sm text-text-primary">Max turns</span>
              <input
                type="number"
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value)}
                className="w-20 px-2 py-1 border border-border-default rounded-md bg-surface-1 font-mono text-base md:text-sm"
                placeholder="--"
                min="1"
              />
            </label>
          </div>

          <div>
            <span className={label}>Color</span>
            <ColorSwatches value={color} onChange={setColor} />
          </div>
        </div>
      </Section>

      {error && <Notice tone="err">{error}</Notice>}

      <div className="flex flex-wrap items-center gap-3">
        <PrimaryAction type="submit" pending={saving}>
          {saving ? 'Creating…' : 'Create role'}
        </PrimaryAction>
        <Link href="/app/settings/roles" className="btn btn-lg h-11 md:h-10">Cancel</Link>
      </div>
    </form>
  );
}
