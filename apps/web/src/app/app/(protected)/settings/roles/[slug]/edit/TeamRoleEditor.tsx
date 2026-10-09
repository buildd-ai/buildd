'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import SettingsPage from '../../../_components/SettingsPage';
import Section from '@/components/ui/Section';
import Segmented from '@/components/ui/Segmented';
import Notice from '@/components/ui/Notice';
import { TonePill } from '@/components/ui/StatePill';
import { Select } from '@/components/ui/Select';
import { BackendSelect, type BackendValue } from '@/components/ui/BackendSelect';
import { ModelPicker, normalizeAlias } from '@/components/ModelPicker';
import { SUBAGENT_TOOLS_LABEL, SUBAGENT_TOOLS_NOTE, subagentToolsSummary } from '@/lib/role-tool-scope';
import { useConfirm } from '@/components/useConfirm';
import { MobileSaveBar, HeaderSaveButton } from '@/components/MobileSaveBar';
import { ColorSwatches } from '@/components/ColorSwatches';
import { useDirtyState, useWarnOnUnload } from '@/hooks/useUnsavedChanges';
import { NOT_FOR_MAX, WHEN_TO_USE_MAX, WHEN_TO_USE_MIN, readRoleRouting } from '@/lib/role-routing';
import { OPERATOR_ROLE_SLUG } from '@/lib/permission-registry';
import { OperatorAccessSection } from './OperatorAccessSection';
import Chip from '@/components/ui/Chip';
import { responseErrorMessage, type RoleVisibility } from '@/lib/personal-roles-shared';

type Scope = 'team' | 'workspace';

const AVAILABLE_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'Agent', 'NotebookEdit',
];

/** Toggle selections: stored order carries no meaning, re-toggling appends. */
const DIRTY_OPTS = { unordered: ['allowedTools', 'canDelegateTo'] as const };

interface Role {
  id: string;
  teamId: string;
  workspaceId: string | null;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  model: string;
  defaultBackend: 'claude' | 'codex' | null;
  allowedTools: string[];
  canDelegateTo: string[];
  background: boolean;
  maxTurns: number | null;
  color: string;
  mcpServers: Record<string, unknown> | string[];
  requiredEnvVars: Record<string, string>;
  isRole: boolean;
  repoUrl: string | null;
  metadata?: unknown;
}

interface WorkspaceOption {
  id: string;
  name: string;
}

interface DelegateOption {
  slug: string;
  name: string;
  /** Workspace name for workspace-scoped roles; undefined for team-level roles */
  workspaceName?: string;
}

interface Props {
  role: Role;
  overrides: Role[];
  workspaces: WorkspaceOption[];
  delegateOptions: DelegateOption[];
  /**
   * Holds `manage_agent_roles` in the role's team (overrides applied). False:
   * the role and its overrides read-only, with no save, delete or new
   * override. Defaults to true.
   */
  canEdit?: boolean;
  /**
   * Set for a personal role: no workspace scope, overrides or operator
   * access (the API refuses them), and a share toggle instead.
   */
  personal?: PersonalRoleInfo;
}

export interface PersonalRoleInfo {
  visibility: RoleVisibility;
  isOwner: boolean;
  /** Owner's name when the viewer is not the owner. */
  ownerName: string | null;
  /** May change who uses it (owner, or an admin once shared). */
  canShare: boolean;
  /** May turn it into a team role (admin, shared only). */
  canPromote: boolean;
}

/** Share choice + "Make team role" for a personal role. */
function PersonalSharingSection({
  roleId,
  slug,
  info,
}: {
  roleId: string;
  slug: string;
  info: PersonalRoleInfo;
}) {
  const router = useRouter();
  const [visibility, setVisibility] = useState<RoleVisibility>(info.visibility);
  const [busy, setBusy] = useState<'share' | 'promote' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promoteWarnings, setPromoteWarnings] = useState<string[] | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  async function changeVisibility(next: RoleVisibility) {
    if (next === visibility || busy) return;
    setBusy('share');
    setError(null);
    try {
      const res = await fetch(`/api/roles/${roleId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: next }),
      });
      const data = await res.json().catch(() => null) as { skill?: { visibility?: string } } | null;
      if (!res.ok) {
        // A 409 slug clash carries the message to show as-is.
        setError(responseErrorMessage(data, next === 'team' ? 'Could not share this role' : 'Could not make this role private'));
        return;
      }
      const stored = data?.skill?.visibility;
      setVisibility(stored === 'team' || stored === 'private' ? stored : next);
      router.refresh();
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  async function promote() {
    if (busy) return;
    if (!(await confirm({
      title: 'Make this a team role?',
      message: 'It becomes the team\u2019s, with no owner, and admins manage it from then on. Its slug stays the same.',
      confirmLabel: 'Make team role',
    }))) return;
    setBusy('promote');
    setError(null);
    try {
      const res = await fetch(`/api/roles/${roleId}/promote`, { method: 'POST' });
      const data = await res.json().catch(() => null) as { warnings?: unknown } | null;
      if (!res.ok) {
        setError(responseErrorMessage(data, 'Could not make this a team role'));
        return;
      }
      const raw = data?.warnings;
      const warnings = Array.isArray(raw) ? raw.filter((w): w is string => typeof w === 'string') : [];
      if (warnings.length > 0) {
        setPromoteWarnings(warnings);
        return;
      }
      router.push(teamRoleHref);
      router.refresh();
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  const teamRoleHref = `/app/settings/roles/${encodeURIComponent(slug)}/edit`;
  const label = (v: RoleVisibility) => (v === 'private' ? (info.isOwner ? 'Only me' : 'Only its owner') : 'Whole team');

  return (
    <Section title="Who can use it">
      <div data-testid="personal-role-sharing" className="space-y-2">
        {promoteWarnings ? (
          <div className="space-y-2" data-testid="personal-role-promoted">
            <p className="text-sm text-text-primary">This is now a team role.</p>
            {promoteWarnings.map(w => <Notice key={w} tone="warn">{w}</Notice>)}
            <Link href={teamRoleHref} className="btn btn-sm">Open the team role</Link>
          </div>
        ) : (
          <>
            {/* Someone who may not change it reads the choice; no dead toggle. */}
            {info.canShare ? (
              <Segmented
                label="Who can use it"
                items={[{ value: 'private', label: label('private') }, { value: 'team', label: label('team') }]}
                value={visibility}
                onChange={changeVisibility}
              />
            ) : (
              <p data-testid="personal-share-fixed" className="text-sm font-medium text-text-primary">{label(visibility)}</p>
            )}
            <p className="text-sm text-text-muted">
              {visibility === 'team'
                ? 'Anyone in the team can run it. Only its owner and admins can change it.'
                : 'Only its owner\u2019s tasks run it. Nobody else can see it.'}
            </p>
            {error && <Notice tone="err" data-testid="personal-share-error">{error}</Notice>}
            {info.canPromote && visibility === 'team' && (
              <div className="flex flex-wrap items-center gap-3 border-t border-border-default pt-3">
                <button
                  type="button"
                  onClick={promote}
                  disabled={busy !== null}
                  data-testid="personal-role-promote"
                  className="btn"
                >
                  {busy === 'promote' ? 'Making team role\u2026' : 'Make team role'}
                </button>
                <span className="text-sm text-text-muted">The team takes it over; the owner no longer manages it.</span>
              </div>
            )}
          </>
        )}
      </div>
      {confirmDialog}
    </Section>
  );
}

/**
 * The payload this editor sends, rebuilt from a stored role with the same
 * normalisation the form's initial state applies. Used as the post-save
 * baseline from the server's echo.
 */
function payloadFromRole(r: Role) {
  const routing = readRoleRouting(r.metadata);
  return {
    name: r.name,
    description: r.description || null,
    whenToUse: routing?.whenToUse ?? null,
    notFor: routing?.notFor ?? null,
    content: r.content,
    model: normalizeAlias(r.model),
    defaultBackend: r.defaultBackend ?? null,
    allowedTools: r.allowedTools,
    canDelegateTo: r.canDelegateTo,
    background: r.background,
    maxTurns: r.maxTurns || null,
    color: r.color,
    workspaceId: undefined as string | null | undefined,
  };
}

/**
 * What Save sends for scope: undefined when it stays where it is, a workspace
 * id for a move into (or between) workspaces, null to make it a team default.
 */
export function scopeChange(current: string | null, scope: Scope, target: string): string | null | undefined {
  if (scope === 'team') return current === null ? undefined : null;
  if (!target || target === current) return undefined;
  return target;
}

/** Fields that can be individually overridden per workspace */
type OverridableField = 'allowedTools' | 'content' | 'mcpServers';
const OVERRIDABLE_FIELDS: { key: OverridableField; label: string }[] = [
  { key: 'allowedTools', label: SUBAGENT_TOOLS_LABEL },
  { key: 'content', label: 'Instructions' },
  { key: 'mcpServers', label: 'Connectors (MCP)' },
];

/** A field this workspace takes from the team default. */
function InheritedBadge() {
  return <TonePill tone="q">Inherited</TonePill>;
}

/** A field this workspace sets for itself. */
function OverrideBadge() {
  return <TonePill tone="run">Override</TonePill>;
}

/** A tool on/off toggle: selected reads as ink on the quiet tint, never orange. */
function toolToggleClass(active: boolean): string {
  return `btn btn-sm h-11 md:h-6 font-mono ${active ? 'bg-[var(--q-tint)] text-text-primary font-semibold' : 'text-text-muted'}`;
}

/** Workspace override editor: shows which fields are overridden vs inherited */
function WorkspaceOverrideEditor({
  override,
  teamDefault,
  workspaceName,
  onUpdate,
  onDelete,
  canEdit = true,
}: {
  override: Role;
  teamDefault: Role;
  workspaceName: string;
  onUpdate: (updates: Partial<Record<OverridableField, unknown>>) => Promise<void>;
  onDelete: () => Promise<void>;
  /** False: the override opens to read, with nothing to change, save or remove. */
  canEdit?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect which fields differ from team default
  const overriddenFields = new Set<OverridableField>();
  if (JSON.stringify(override.allowedTools) !== JSON.stringify(teamDefault.allowedTools)) {
    overriddenFields.add('allowedTools');
  }
  if (override.content !== teamDefault.content) {
    overriddenFields.add('content');
  }
  if (JSON.stringify(override.mcpServers) !== JSON.stringify(teamDefault.mcpServers)) {
    overriddenFields.add('mcpServers');
  }

  // Editable state for overridable fields
  const [allowedTools, setAllowedTools] = useState<string[]>(override.allowedTools);
  const [content, setContent] = useState(override.content);
  const [overrideField, setOverrideField] = useState<Set<OverridableField>>(new Set(overriddenFields));

  function toggleToolOverride(tool: string) {
    setAllowedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
    setOverrideField(prev => { const s = new Set(prev); s.add('allowedTools'); return s; });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    const updates: Partial<Record<OverridableField, unknown>> = {};
    if (overrideField.has('allowedTools')) updates.allowedTools = allowedTools;
    if (overrideField.has('content')) updates.content = content;
    try {
      await onUpdate(updates);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  function resetField(field: OverridableField) {
    setOverrideField(prev => { const s = new Set(prev); s.delete(field); return s; });
    if (field === 'allowedTools') setAllowedTools(teamDefault.allowedTools);
    if (field === 'content') setContent(teamDefault.content);
  }

  /** The Override / Reset control beside a field label. */
  const fieldControl = (field: OverridableField, onOverride: () => void) => overrideField.has(field) ? (
    <>
      <OverrideBadge />
      <button type="button" onClick={() => resetField(field)} className="btn-quiet ml-auto min-h-11 md:min-h-0">
        Reset to inherited
      </button>
    </>
  ) : (
    <>
      <InheritedBadge />
      <button type="button" onClick={onOverride} className="btn-quiet ml-auto min-h-11 md:min-h-0">
        Override
      </button>
    </>
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full min-h-14 items-center justify-between gap-3 py-2.5 text-left hover:bg-surface-3 transition-colors"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-text-primary">{workspaceName}</span>
          <span className="block text-sm text-text-muted">
            {overriddenFields.size > 0
              ? `${overriddenFields.size} field${overriddenFields.size !== 1 ? 's' : ''} overridden`
              : 'All inherited'}
          </span>
        </span>
        <span aria-hidden="true" className={`shrink-0 font-mono text-meta text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {expanded && (
        <fieldset disabled={!canEdit} className="min-w-0 space-y-5 pb-4">
          {/* Subagent tools */}
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">{SUBAGENT_TOOLS_LABEL}</span>
              {fieldControl('allowedTools', () => setOverrideField(prev => { const s = new Set(prev); s.add('allowedTools'); return s; }))}
            </div>
            {overrideField.has('allowedTools') ? (
              <div className="flex flex-wrap gap-1.5">
                {AVAILABLE_TOOLS.map(tool => {
                  const active = allowedTools.includes(tool);
                  return (
                    <button
                      key={tool}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleToolOverride(tool)}
                      className={toolToggleClass(active)}
                    >
                      {tool}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="font-mono text-meta text-text-muted">
                {teamDefault.allowedTools.length === 0 ? 'Subagent defaults' : teamDefault.allowedTools.join(', ')}
              </p>
            )}
            <p className="mt-1 text-sm text-text-muted">{SUBAGENT_TOOLS_NOTE}</p>
          </div>

          {/* Instructions */}
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">Instructions</span>
              {fieldControl('content', () => setOverrideField(prev => { const s = new Set(prev); s.add('content'); return s; }))}
            </div>
            {overrideField.has('content') ? (
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={8}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-base md:text-sm text-text-primary"
                placeholder="Custom instructions for this workspace…"
              />
            ) : (
              <pre className="line-clamp-3 whitespace-pre-wrap font-mono text-meta text-text-muted">
                {teamDefault.content.slice(0, 200)}{teamDefault.content.length > 200 ? '…' : ''}
              </pre>
            )}
          </div>

          {error && <Notice tone="err">{error}</Notice>}

          {canEdit && (
            <div className="flex items-center gap-3">
              <button type="button" onClick={handleSave} disabled={saving} className="btn">
                {saving ? 'Saving…' : 'Save override'}
              </button>
              <button type="button" onClick={onDelete} className="btn-quiet min-h-11 md:min-h-0">
                Remove override
              </button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}

export function TeamRoleEditor({ role, overrides, workspaces: userWorkspaces, delegateOptions, canEdit = true, personal }: Props) {
  const { confirm, confirmDialog } = useConfirm();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideList, setOverrideList] = useState<Role[]>(overrides);

  // Core role state
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description || '');
  const initialRouting = readRoleRouting(role.metadata);
  const routingDisabled = initialRouting?.disabled === true;
  const [whenToUse, setWhenToUse] = useState(initialRouting?.whenToUse ?? '');
  const [notFor, setNotFor] = useState(initialRouting?.notFor ?? '');
  const [content, setContent] = useState(role.content);
  const [model, setModel] = useState(role.model);
  const [defaultBackend, setDefaultBackend] = useState<BackendValue>(role.defaultBackend ?? null);
  const [allowedTools, setAllowedTools] = useState<string[]>(role.allowedTools);
  const [canDelegateTo, setCanDelegateTo] = useState<string[]>(role.canDelegateTo);
  const [background, setBackground] = useState(role.background);
  const [maxTurns, setMaxTurns] = useState<string>(role.maxTurns?.toString() || '');
  const [color, setColor] = useState(role.color);

  // Scope (applies-to): a workspace-scoped role opens on its own workspace,
  // so choosing "All workspaces in team" is what promotes it.
  const isWorkspaceRole = role.workspaceId !== null;
  const [scope, setScope] = useState<Scope>(isWorkspaceRole ? 'workspace' : 'team');
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string>(role.workspaceId ?? userWorkspaces[0]?.id ?? '');

  // Add override state
  const [showAddOverride, setShowAddOverride] = useState(false);
  const [addOverrideWsId, setAddOverrideWsId] = useState(userWorkspaces[0]?.id || '');
  const [addingOverride, setAddingOverride] = useState(false);

  const toggleTool = (tool: string) => {
    setAllowedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
  };

  const toggleDelegate = (slug: string) => {
    setCanDelegateTo(prev =>
      prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]
    );
  };

  // What Save would send. Dirty = this differs from the last-saved copy.
  // Workspace overrides save independently and are deliberately not in here.
  const payload = {
    name,
    description: description || null,
    whenToUse: whenToUse.trim() || null,
    notFor: notFor.trim() || null,
    content,
    // ModelPicker rewrites legacy aliases (sonnet → standard) on mount; the
    // two save the same tier, so compare canonically or the form loads dirty.
    model: normalizeAlias(model),
    defaultBackend,
    allowedTools,
    canDelegateTo,
    background,
    maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
    color,
    // Only a move changes anything on save: to a workspace, or (null) up to the team.
    workspaceId: scopeChange(role.workspaceId, scope, targetWorkspaceId),
  };
  const { dirty, snapshot, markSaved, snapshotOf } = useDirtyState(payload, DIRTY_OPTS);
  useWarnOnUnload(dirty);

  async function handleSave() {
    const submitted = snapshot;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const body: Record<string, unknown> = { ...payload };
      if (body.workspaceId === undefined) delete body.workspaceId;

      const res = await fetch(`/api/roles/${role.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      // Baseline = what the server says it stored; fall back to what we sent.
      const data = await res.json().catch(() => null) as { skill?: Role } | null;
      markSaved(data?.skill ? snapshotOf(payloadFromRole(data.skill)) : submitted);

      // A move re-reads the row: this same page resolves it at its new scope.
      if (body.workspaceId !== undefined) {
        router.push(`/app/settings/roles/${encodeURIComponent(role.slug)}/edit?id=${encodeURIComponent(role.id)}`);
        router.refresh();
        return;
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!(await confirm({ title: `Delete role "${role.name}"?`, message: 'Deletes the role and its workspace overrides. You can’t undo this.', confirmLabel: 'Delete role', variant: 'danger' }))) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/roles/${role.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      router.push('/app/settings/roles');
      router.refresh();
    } catch {
      setError('Failed to delete role');
      setDeleting(false);
    }
  }

  async function handleUpdateOverride(overrideId: string, wsId: string, updates: Partial<Record<string, unknown>>) {
    const res = await fetch(`/api/roles/${role.id}/overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: wsId, ...updates }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to update override');
    }
    const data = await res.json();
    setOverrideList(prev => prev.map(o => o.id === overrideId ? data.skill : o));
  }

  async function handleDeleteOverride(overrideId: string) {
    if (!(await confirm({ title: 'Remove workspace override?', message: 'The workspace goes back to the team default.', confirmLabel: 'Remove override', variant: 'danger' }))) return;
    const res = await fetch(`/api/roles/${overrideId}`, { method: 'DELETE' });
    if (res.ok) {
      setOverrideList(prev => prev.filter(o => o.id !== overrideId));
    }
  }

  async function handleAddOverride() {
    if (!addOverrideWsId) return;
    setAddingOverride(true);
    try {
      const res = await fetch(`/api/roles/${role.id}/overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: addOverrideWsId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create override');
      }
      const data = await res.json();
      setOverrideList(prev => [...prev, data.skill]);
      setShowAddOverride(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create override');
    } finally {
      setAddingOverride(false);
    }
  }

  const wsMap = new Map(userWorkspaces.map(w => [w.id, w.name]));
  const overrideWsIds = new Set(overrideList.map(o => o.workspaceId).filter(Boolean));
  const availableForOverride = userWorkspaces.filter(w => !overrideWsIds.has(w.id));

  const scopeTone = isWorkspaceRole
    ? <TonePill tone="q">{wsMap.get(role.workspaceId!) ?? 'One workspace'}</TonePill>
    : <TonePill tone="q">All workspaces</TonePill>;

  return (
    <SettingsPage
      title={name || role.slug}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-meta">{role.slug}</span>
          {personal ? (
            <>
              <Chip tone="muted" dot={false} data-testid="personal-role-badge">
                {personal.isOwner ? 'Yours' : 'Personal'}
              </Chip>
              {!personal.isOwner && <span>by {personal.ownerName || 'a teammate'}</span>}
            </>
          ) : scopeTone}
        </span>
      }
    >
      {/* Desktop save; phones get the sticky MobileSaveBar at the bottom. */}
      {canEdit ? (
        <div className="hidden md:flex justify-end">
          <HeaderSaveButton dirty={dirty} saving={saving} saved={saved} onSave={handleSave} label="Save role" />
        </div>
      ) : (
        <p data-testid="role-read-only" className="text-sm text-text-muted">
          {personal ? 'Only its owner or a team admin can change this role.' : 'Admins can change this role.'}
        </p>
      )}

      {personal && <PersonalSharingSection roleId={role.id} slug={role.slug} info={personal} />}

      {error && <Notice tone="err">{error}</Notice>}

      {/* A disabled fieldset disables every control inside it: the role
          stays readable, nothing in it can be changed. */}
      <fieldset disabled={!canEdit} className="min-w-0 space-y-8">
        {/* Applies to (team roles; a personal role is always team-level) */}
        {!personal && (
          <Section title="Applies to">
            <div className="space-y-2">
              {userWorkspaces.length > 0 ? (
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
                  {isWorkspaceRole
                    ? 'Saving makes this the team default for every workspace.'
                    : 'Every workspace in your team gets this role by default. A workspace can add an override.'}
                </p>
              )}

              {scope === 'workspace' && userWorkspaces.length > 0 && (
                <>
                  <Select
                    value={targetWorkspaceId}
                    onChange={setTargetWorkspaceId}
                    options={userWorkspaces.map(w => ({ value: w.id, label: w.name }))}
                    size="sm"
                  />
                  <p className="text-sm text-text-muted">
                    {isWorkspaceRole && targetWorkspaceId === role.workspaceId
                      ? 'Only this workspace runs it.'
                      : 'Saving moves this role to the selected workspace.'}
                    {!isWorkspaceRole && overrideList.length > 0 && (
                      <> {overrideList.length} workspace override{overrideList.length !== 1 ? 's' : ''} become standalone roles.</>
                    )}
                  </p>
                </>
              )}
            </div>
          </Section>
        )}

        <Section title="Role">
          <div className="space-y-5">
            <div>
              <label htmlFor="role-name" className="mb-1.5 block text-sm font-medium text-text-primary">Role name</label>
              <input
                id="role-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary text-base md:text-sm"
              />
            </div>

            <div>
              <label htmlFor="role-goal" className="mb-1.5 block text-sm font-medium text-text-primary">Goal</label>
              <input
                id="role-goal"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary text-base md:text-sm"
                placeholder="Describe this role's core purpose"
              />
            </div>

            <div>
              <label htmlFor="role-when-to-use" className="mb-1.5 block text-sm font-medium text-text-primary">When to use</label>
              <textarea
                id="role-when-to-use"
                value={whenToUse}
                onChange={(e) => setWhenToUse(e.target.value)}
                rows={2}
                maxLength={WHEN_TO_USE_MAX}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary text-base md:text-sm"
                placeholder="Code changes that end in a PR: features, bug fixes, refactors, migrations"
              />
              <p className="mt-1 text-sm text-text-muted">
                {routingDisabled
                  ? 'Routing is turned off for this role: tasks reach it only when they name it.'
                  : `The work this role should pick up, ${WHEN_TO_USE_MIN} to ${WHEN_TO_USE_MAX} characters. Tasks filed without a role are matched against it; a role left blank is never picked.`}
              </p>
            </div>

            <div>
              <label htmlFor="role-not-for" className="mb-1.5 block text-sm font-medium text-text-primary">Not for</label>
              <input
                id="role-not-for"
                type="text"
                value={notFor}
                onChange={(e) => setNotFor(e.target.value)}
                maxLength={NOT_FOR_MAX}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-text-primary text-base md:text-sm"
                placeholder="Investigating without changing code (Researcher)"
              />
              <p className="mt-1 text-sm text-text-muted">Optional. The nearest work that belongs to another role, and which one.</p>
            </div>

            <div>
              <label htmlFor="role-instructions" className="mb-1.5 block text-sm font-medium text-text-primary">Instructions</label>
              <textarea
                id="role-instructions"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={14}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-base md:text-sm text-text-primary"
                placeholder="You are Builder, a senior software engineer…"
              />
              <p className="mt-1 text-sm text-text-muted">The full system prompt for this role.{personal || isWorkspaceRole ? '' : ' A workspace can override it.'}</p>
            </div>
          </div>
        </Section>

        <Section title="How it runs">
          <div className="space-y-6">
            <div>
              <span className="mb-2 block text-sm font-medium text-text-primary">Model</span>
              <ModelPicker value={model} onChange={setModel} />
            </div>

            <div>
              <span className="mb-2 block text-sm font-medium text-text-primary">Agent backend</span>
              <BackendSelect value={defaultBackend} onChange={setDefaultBackend} inheritLabel="Inherit" />
            </div>

            {delegateOptions.length > 0 && (
              <div>
                <span className="mb-2 block text-sm font-medium text-text-primary">Can delegate to</span>
                <div className="flex flex-wrap gap-2">
                  {(() => {
                    // canDelegateTo stores slugs, so one toggle per slug (the
                    // server dedupes too; this keeps React keys unique).
                    const uniqueOptions = [...new Map(delegateOptions.map(o => [o.slug, o] as const)).values()];
                    // Detect duplicate names so we can qualify them with workspace context
                    const nameCount = new Map<string, number>();
                    for (const opt of uniqueOptions) {
                      nameCount.set(opt.name, (nameCount.get(opt.name) ?? 0) + 1);
                    }
                    return uniqueOptions.map(opt => {
                      const active = canDelegateTo.includes(opt.slug);
                      const isAmbiguous = (nameCount.get(opt.name) ?? 0) > 1;
                      const label = isAmbiguous && opt.workspaceName
                        ? `${opt.workspaceName}/${opt.name}`
                        : opt.name;
                      return (
                        <button
                          key={opt.slug}
                          type="button"
                          aria-pressed={active}
                          onClick={() => toggleDelegate(opt.slug)}
                          className={`btn h-11 md:h-8 ${active ? 'bg-[var(--q-tint)] text-text-primary font-semibold' : 'text-text-secondary'}`}
                        >
                          {label}
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>
            )}

            {/* Subagent tools */}
            <details className="group">
              <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-text-primary">
                {SUBAGENT_TOOLS_LABEL}
                <span className="font-normal text-text-muted">{subagentToolsSummary(allowedTools)}</span>
              </summary>
              <div className="mt-3">
                <div className="flex flex-wrap gap-2">
                  {AVAILABLE_TOOLS.map(tool => {
                    const active = allowedTools.includes(tool);
                    return (
                      <button
                        key={tool}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleTool(tool)}
                        className={toolToggleClass(active)}
                      >
                        {tool}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 text-sm text-text-muted">{SUBAGENT_TOOLS_NOTE}{personal || isWorkspaceRole ? '' : ' Individual workspaces can override it.'}</p>
              </div>
            </details>

            <div className="divide-y divide-border-default border-y border-border-default">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 py-2">
                <input
                  type="checkbox"
                  checked={background}
                  onChange={(e) => setBackground(e.target.checked)}
                  className="rounded border-border-default"
                />
                <span className="text-sm text-text-primary">Allow background execution</span>
              </label>
              <label className="flex min-h-11 items-center justify-between gap-2 py-2">
                <span className="text-sm text-text-primary">Max turns</span>
                <input
                  type="number"
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                  className="w-20 min-h-11 md:min-h-0 px-2 py-1 border border-border-default rounded-md bg-surface-1 font-mono text-base md:text-sm text-text-primary"
                  placeholder="--"
                  min="1"
                />
              </label>
            </div>

            <div>
              <span className="mb-2 block text-sm font-medium text-text-primary">Avatar color</span>
              <ColorSwatches value={color} onChange={setColor} size="md" />
            </div>
          </div>
        </Section>
      </fieldset>

      {/* Platform Operator access: a distinct admin surface, not a content/tools/mcp override. */}
      {!personal && !isWorkspaceRole && role.slug === OPERATOR_ROLE_SLUG && (
        <OperatorAccessSection
          roleId={role.id}
          teamMetadata={role.metadata}
          overrides={overrideList}
          workspaces={userWorkspaces}
          canEdit={canEdit}
        />
      )}

      {/* Workspace overrides hang off a team default; a workspace role has none. */}
      {!personal && !isWorkspaceRole && role.slug !== OPERATOR_ROLE_SLUG && (
        <Section
          title="Workspace overrides"
          action={canEdit && availableForOverride.length > 0 ? (
            <button type="button" onClick={() => setShowAddOverride(!showAddOverride)} className="btn btn-sm h-11 md:h-6">
              + Add override
            </button>
          ) : undefined}
        >
          <div className="space-y-4">
            <p className="text-sm text-text-muted">
              A workspace can override single fields. The rest inherit the team default above.
            </p>

            {canEdit && showAddOverride && availableForOverride.length > 0 && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Select
                    value={addOverrideWsId}
                    onChange={setAddOverrideWsId}
                    options={availableForOverride.map(w => ({ value: w.id, label: w.name }))}
                    size="sm"
                  />
                  <button
                    type="button"
                    onClick={handleAddOverride}
                    disabled={addingOverride || !addOverrideWsId}
                    className="btn"
                  >
                    {addingOverride ? 'Creating…' : 'Create override'}
                  </button>
                  <button type="button" onClick={() => setShowAddOverride(false)} className="btn-quiet">
                    Cancel
                  </button>
                </div>
                <p className="text-sm text-text-muted">
                  The override starts as a copy of the team default. Change the fields you need for this workspace.
                </p>
              </div>
            )}

            {overrideList.length === 0 ? (
              <p className="text-sm text-text-muted">No workspace overrides. All workspaces use the team default.</p>
            ) : (
              <div className="divide-y divide-border-default border-y border-border-default">
                {overrideList.map(override => {
                  const wsId = override.workspaceId!;
                  const wsName = wsMap.get(wsId) || wsId;
                  return (
                    <WorkspaceOverrideEditor
                      key={override.id}
                      override={override}
                      teamDefault={role}
                      workspaceName={wsName}
                      onUpdate={(updates) => handleUpdateOverride(override.id, wsId, updates)}
                      onDelete={() => handleDeleteOverride(override.id)}
                      canEdit={canEdit}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Resolution summary */}
      {!personal && !isWorkspaceRole && role.slug !== OPERATOR_ROLE_SLUG && userWorkspaces.length > 0 && (
        <Section title="Effective role per workspace">
          <div className="divide-y divide-border-default border-y border-border-default">
            {userWorkspaces.map(ws => {
              const override = overrideList.find(o => o.workspaceId === ws.id);
              return (
                <div key={ws.id} className="flex min-h-11 items-center justify-between gap-3 py-2">
                  <span className="truncate text-sm text-text-primary">{ws.name}</span>
                  {override
                    ? <TonePill tone="run">Workspace override</TonePill>
                    : <TonePill tone="q">Team default</TonePill>}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {canEdit && (
        <Section title="Danger zone">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">
              {isWorkspaceRole || personal ? 'Deletes the role.' : 'Deletes the role and its workspace overrides.'}
            </p>
            <button type="button" onClick={handleDelete} disabled={deleting} className="btn btn-danger">
              {deleting ? 'Deleting…' : 'Delete this role'}
            </button>
          </div>
        </Section>
      )}

      {/* Saves the role above, not the overrides: those keep their own
          "Save override" buttons. */}
      {canEdit && <MobileSaveBar onSave={handleSave} saving={saving} saved={saved} error={error} dirty={dirty} label="Save role" />}
      {confirmDialog}
    </SettingsPage>
  );
}
