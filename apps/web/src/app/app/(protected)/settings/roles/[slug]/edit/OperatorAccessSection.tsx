'use client';

/**
 * Admin UX for the Operator capability model (docs/specs/agent-capabilities.md):
 * makes `metadata.operator` on the team default row and each workspace's
 * override row legible and editable, without exposing any credential value —
 * scope only ever carries a provider/project/environment/credential-ref
 * *label*. Deploy/use capabilities (standard tier) and secret
 * management/reveal (elevated tier, off by default) are rendered as visually
 * separate groups so the distinction survives in the UI, not just the schema.
 *
 * Mirrors the "Applies to" + inherited/override badge language the generic
 * `WorkspaceOverrideEditor` in `TeamRoleEditor.tsx` already established, but
 * is its own section: an operator grant is not a content/tools/mcp override,
 * and a workspace needs this editor whether or not it has ever created one.
 */
import { useState } from 'react';
import {
  AGENT_CAPABILITIES,
  AGENT_CAPABILITY_NAMES,
  ELEVATED_AGENT_CAPABILITIES,
  type AgentCapability,
} from '@/lib/permission-registry';
import {
  resolveOperatorGrant,
  sanitizeOperatorGrantConfig,
  SCOPE_DIMENSIONS,
  type DeploymentScope,
  type OperatorGrantConfig,
  type ScopeDimension,
} from '@/lib/operator-capability';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import Eyebrow from '@/components/ui/Eyebrow';
import { TonePill } from '@/components/ui/StatePill';

const STANDARD_CAPS = AGENT_CAPABILITY_NAMES.filter(c => !ELEVATED_AGENT_CAPABILITIES.has(c));
const ELEVATED_CAPS = AGENT_CAPABILITY_NAMES.filter(c => ELEVATED_AGENT_CAPABILITIES.has(c));

const DIMENSION_LABEL: Record<ScopeDimension, string> = {
  providers: 'Providers',
  projects: 'Projects',
  environments: 'Environments',
  credentialRefs: 'Credential refs',
};

function emptyScope(): Record<ScopeDimension, string[]> {
  return { providers: [], projects: [], environments: [], credentialRefs: [] };
}

interface OperatorRoleRow {
  id: string;
  workspaceId: string | null;
  metadata?: unknown;
}

interface WorkspaceOption {
  id: string;
  name: string;
}

function CapabilityCheckbox({
  capability,
  checked,
  onToggle,
  elevated,
}: {
  capability: AgentCapability;
  checked: boolean;
  onToggle: () => void;
  elevated?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 rounded border-border-default"
      />
      <span>
        <span className={`block text-meta font-mono ${elevated ? 'text-status-warning' : 'text-text-primary'}`}>
          {capability}
        </span>
        <span className="block text-meta text-text-muted">{AGENT_CAPABILITIES[capability].description}</span>
      </span>
    </label>
  );
}

function ChipListEditor({
  label,
  hint,
  values,
  onChange,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  function commit() {
    const v = draft.trim().toLowerCase();
    setDraft('');
    if (v && v !== '*' && !values.includes(v)) onChange([...values, v]);
  }
  return (
    <div>
      <label className="block text-meta font-medium text-text-primary mb-1">{label}</label>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {values.map(v => (
            <TonePill key={v} tone="q">
              {v}
              <button
                type="button"
                onClick={() => onChange(values.filter(x => x !== v))}
                className="inline-flex items-center justify-center min-h-11 min-w-11 md:min-h-0 md:min-w-0 text-text-muted hover:text-status-error"
                aria-label={`Remove ${v}`}
              >
                ×
              </button>
            </TonePill>
          ))}
        </div>
      )}
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder="Name a target, Enter to add"
        className="w-full px-2.5 py-1.5 border border-border-default rounded-md bg-surface-1 text-text-primary text-meta"
      />
      {hint && <p className="text-meta text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

/** Resolved-grant preview: what `authorizeAgent` would actually see, live as the draft changes. */
function EffectiveGrantPreview({ grant }: { grant: ReturnType<typeof resolveOperatorGrant> }) {
  return (
    <div className="border-t border-border-default pt-3">
      <div className="mb-1.5 flex items-center gap-2">
        <Eyebrow tone="muted">Effective grant</Eyebrow>
        {grant.enabled ? <TonePill tone="ok">Enabled</TonePill> : <TonePill tone="q">Disabled</TonePill>}
      </div>
      {grant.enabled && (
        <>
          <div className="mb-1.5 flex flex-wrap gap-1">
            {grant.capabilities.length === 0 && <span className="text-meta text-text-muted">No capabilities granted</span>}
            {grant.capabilities.map(c => (
              <TonePill key={c} tone={ELEVATED_AGENT_CAPABILITIES.has(c) ? 'dec' : 'q'}>{c}</TonePill>
            ))}
          </div>
          <div className="space-y-0.5">
            {SCOPE_DIMENSIONS.map(dim => (
              <div key={dim} className="text-meta text-text-muted">
                <span className="text-text-secondary">{DIMENSION_LABEL[dim]}:</span>{' '}
                {grant.scope[dim].length > 0 ? grant.scope[dim].join(', ') : 'none'}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Team-level ceiling: a kill switch, the standard-capability ceiling, and optional scope ceilings. Never elevated. */
function TeamCeilingCard({ roleId, metadata, canEdit = true }: { roleId: string; metadata: unknown; canEdit?: boolean }) {
  const initial = sanitizeOperatorGrantConfig((metadata as { operator?: unknown } | null)?.operator) ?? {};
  const [killSwitchOff, setKillSwitchOff] = useState(initial.enabled === false);
  const [caps, setCaps] = useState<Set<AgentCapability>>(
    new Set(initial.capabilities?.filter(c => !ELEVATED_AGENT_CAPABILITIES.has(c)) ?? STANDARD_CAPS)
  );
  const [scope, setScope] = useState<Record<ScopeDimension, string[]>>({ ...emptyScope(), ...initial.scope });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleCap(c: AgentCapability) {
    setCaps(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    const config: OperatorGrantConfig = {};
    if (killSwitchOff) config.enabled = false;
    const isFullCeiling = caps.size === STANDARD_CAPS.length && STANDARD_CAPS.every(c => caps.has(c));
    if (!isFullCeiling) config.capabilities = [...caps];
    const scopeEntries = SCOPE_DIMENSIONS.filter(d => scope[d].length > 0);
    if (scopeEntries.length > 0) config.scope = Object.fromEntries(scopeEntries.map(d => [d, scope[d]])) as Partial<DeploymentScope>;
    try {
      const res = await fetch(`/api/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorGrant: config }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset disabled={!canEdit} className="min-w-0">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">Team ceiling</h3>
        <label className="flex min-h-11 md:min-h-0 items-center gap-2 cursor-pointer">
          <span className="text-meta text-text-secondary">Allow workspaces to enable this role</span>
          <input
            type="checkbox"
            checked={!killSwitchOff}
            onChange={e => setKillSwitchOff(!e.target.checked)}
            className="rounded border-border-default"
          />
        </label>
      </div>
      <p className="text-meta text-text-muted mb-3">
        Turning this off disables Operator for every workspace, including ones already opted in.
      </p>

      <div className={killSwitchOff ? 'opacity-50 pointer-events-none' : ''}>
        <div className="mb-3">
          <span className="block text-meta font-medium text-text-primary mb-1.5">Deploy and use capabilities</span>
          <div className="space-y-2">
            {STANDARD_CAPS.map(c => (
              <CapabilityCheckbox key={c} capability={c} checked={caps.has(c)} onToggle={() => toggleCap(c)} />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          {SCOPE_DIMENSIONS.map(dim => (
            <ChipListEditor
              key={dim}
              label={`${DIMENSION_LABEL[dim]} ceiling`}
              hint="Leave blank: no ceiling, each workspace picks its own list."
              values={scope[dim]}
              onChange={v => setScope(prev => ({ ...prev, [dim]: v }))}
            />
          ))}
        </div>

        <p className="text-meta text-text-muted">
          Secret management and reveal authority can only be granted per workspace, never at the team level.
        </p>
      </div>

      {error && <Notice tone="err" className="mt-3">{error}</Notice>}

      {canEdit && <div className="mt-3 flex items-center gap-3">
        <button type="button" onClick={handleSave} disabled={saving} className="btn">
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save team ceiling'}
        </button>
      </div>}
    </fieldset>
  );
}

/** One workspace's own opt-in: enabled state, capabilities (standard + elevated, visually split), and scope. */
function WorkspaceGrantRow({
  roleId,
  workspace,
  override,
  teamMetadata,
  onSaved,
  canEdit = true,
}: {
  roleId: string;
  workspace: WorkspaceOption;
  override: OperatorRoleRow | undefined;
  teamMetadata: unknown;
  onSaved: (override: OperatorRoleRow) => void;
  canEdit?: boolean;
}) {
  const initial = sanitizeOperatorGrantConfig((override?.metadata as { operator?: unknown } | null)?.operator) ?? {};
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(initial.enabled === true);
  const [standardCaps, setStandardCaps] = useState<Set<AgentCapability>>(
    new Set(initial.capabilities ? initial.capabilities.filter(c => STANDARD_CAPS.includes(c)) : STANDARD_CAPS)
  );
  const [elevatedCaps, setElevatedCaps] = useState<Set<AgentCapability>>(
    new Set(initial.capabilities?.filter(c => ELEVATED_AGENT_CAPABILITIES.has(c)) ?? [])
  );
  const [scope, setScope] = useState<Record<ScopeDimension, string[]>>({ ...emptyScope(), ...initial.scope });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleStandard(c: AgentCapability) {
    setStandardCaps(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }
  function toggleElevated(c: AgentCapability) {
    setElevatedCaps(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  const draftConfig: OperatorGrantConfig = {
    enabled,
    capabilities: [...standardCaps, ...elevatedCaps],
    scope,
  };
  const preview = resolveOperatorGrant({
    roleSlug: 'operator',
    workspaceId: workspace.id,
    teamRow: { enabled: true, metadata: { operator: (teamMetadata as { operator?: unknown } | null)?.operator } },
    workspaceRow: { enabled: true, metadata: { operator: draftConfig } },
  });

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    const config: OperatorGrantConfig = { enabled, capabilities: [...standardCaps, ...elevatedCaps] };
    const scopeEntries = SCOPE_DIMENSIONS.filter(d => scope[d].length > 0);
    if (scopeEntries.length > 0) config.scope = Object.fromEntries(scopeEntries.map(d => [d, scope[d]])) as Partial<DeploymentScope>;
    try {
      const res = await fetch(`/api/roles/${roleId}/overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id, operatorGrant: config }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      const data = await res.json();
      onSaved(data.skill);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full min-h-14 items-center justify-between gap-3 py-2.5 text-left hover:bg-surface-3 transition-colors"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-text-primary">{workspace.name}</span>
          {preview.enabled ? <TonePill tone="ok">Enabled</TonePill> : <TonePill tone="q">Disabled</TonePill>}
          {preview.capabilities.some(c => ELEVATED_AGENT_CAPABILITIES.has(c)) && <TonePill tone="dec">Elevated</TonePill>}
        </span>
        <span aria-hidden="true" className={`shrink-0 font-mono text-meta text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {expanded && (
        <fieldset disabled={!canEdit} className="min-w-0 space-y-4 pb-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
              className="rounded border-border-default"
            />
            <span className="text-body text-text-primary">Enabled for this workspace</span>
          </label>

          <div>
            <span className="block text-meta font-medium text-text-primary mb-1.5">Deploy and use</span>
            <div className="space-y-2">
              {STANDARD_CAPS.map(c => (
                <CapabilityCheckbox key={c} capability={c} checked={standardCaps.has(c)} onToggle={() => toggleStandard(c)} />
              ))}
            </div>
          </div>

          <Notice tone="warn" title="Secret management and reveal: off by default">
            <p className="mb-2 text-text-muted">
              Lets the agent change or read a credential&apos;s plaintext, not just use it server-side.
            </p>
            <div className="space-y-2">
              {ELEVATED_CAPS.map(c => (
                <CapabilityCheckbox key={c} capability={c} checked={elevatedCaps.has(c)} onToggle={() => toggleElevated(c)} elevated />
              ))}
            </div>
          </Notice>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {SCOPE_DIMENSIONS.map(dim => (
              <ChipListEditor
                key={dim}
                label={DIMENSION_LABEL[dim]}
                values={scope[dim]}
                onChange={v => setScope(prev => ({ ...prev, [dim]: v }))}
              />
            ))}
          </div>

          <EffectiveGrantPreview grant={preview} />

          {error && <Notice tone="err">{error}</Notice>}

          {canEdit && <div className="flex items-center gap-3">
            <button type="button" onClick={handleSave} disabled={saving} className="btn">
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save workspace grant'}
            </button>
          </div>}
        </fieldset>
      )}
    </div>
  );
}

export function OperatorAccessSection({
  roleId,
  teamMetadata,
  overrides,
  workspaces,
  canEdit = true,
}: {
  roleId: string;
  teamMetadata: unknown;
  overrides: OperatorRoleRow[];
  workspaces: WorkspaceOption[];
  /** Holds `manage_agent_roles`. False: the ceiling and each grant read-only. Defaults to true. */
  canEdit?: boolean;
}) {
  const [overrideList, setOverrideList] = useState<OperatorRoleRow[]>(overrides);

  function handleSaved(updated: OperatorRoleRow) {
    setOverrideList(prev => {
      const idx = prev.findIndex(o => o.workspaceId === updated.workspaceId);
      if (idx === -1) return [...prev, updated];
      const next = [...prev];
      next[idx] = updated;
      return next;
    });
  }

  return (
    <Section title="Platform Operator access">
      <div className="space-y-6">
        <p className="text-sm text-text-muted">
          Deploy and use capabilities are separate from secret management and reveal, which stays off by default.
        </p>

        <TeamCeilingCard roleId={roleId} metadata={teamMetadata} canEdit={canEdit} />

        <div>
          <h3 className="mb-1 text-sm font-semibold text-text-primary">Workspace grants</h3>
          {workspaces.length === 0 ? (
            <p className="text-sm text-text-muted">No workspaces to configure.</p>
          ) : (
            <div className="divide-y divide-border-default border-y border-border-default">
              {workspaces.map(ws => (
                <WorkspaceGrantRow
                  key={ws.id}
                  roleId={roleId}
                  workspace={ws}
                  override={overrideList.find(o => o.workspaceId === ws.id)}
                  teamMetadata={teamMetadata}
                  onSaved={handleSaved}
                  canEdit={canEdit}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}
