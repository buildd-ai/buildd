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
        <span className={`block text-[12px] font-mono ${elevated ? 'text-status-warning' : 'text-text-primary'}`}>
          {capability}
        </span>
        <span className="block text-[11px] text-text-muted">{AGENT_CAPABILITIES[capability].description}</span>
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
      <label className="block text-[12px] font-medium text-text-primary mb-1">{label}</label>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {values.map(v => (
            <span
              key={v}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-3 text-text-primary text-[11px] font-mono"
            >
              {v}
              <button
                type="button"
                onClick={() => onChange(values.filter(x => x !== v))}
                className="text-text-muted hover:text-status-error"
                aria-label={`Remove ${v}`}
              >
                ×
              </button>
            </span>
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
        className="w-full px-2.5 py-1.5 border border-border-default rounded-md bg-surface-1 text-text-primary text-[12px]"
      />
      {hint && <p className="text-[11px] text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

/** Resolved-grant preview: what `authorizeAgent` would actually see, live as the draft changes. */
function EffectiveGrantPreview({ grant }: { grant: ReturnType<typeof resolveOperatorGrant> }) {
  return (
    <div className="p-3 rounded-md bg-surface-2 border border-border-default">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Effective grant</span>
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${
            grant.enabled ? 'bg-status-success/10 text-status-success' : 'bg-surface-3 text-text-muted'
          }`}
        >
          {grant.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      {grant.enabled && (
        <>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {grant.capabilities.length === 0 && <span className="text-[11px] text-text-muted">No capabilities granted</span>}
            {grant.capabilities.map(c => (
              <span
                key={c}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                  ELEVATED_AGENT_CAPABILITIES.has(c) ? 'bg-status-warning/10 text-status-warning' : 'bg-surface-3 text-text-secondary'
                }`}
              >
                {c}
              </span>
            ))}
          </div>
          <div className="space-y-0.5">
            {SCOPE_DIMENSIONS.map(dim => (
              <div key={dim} className="text-[11px] text-text-muted">
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
function TeamCeilingCard({ roleId, metadata }: { roleId: string; metadata: unknown }) {
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
    <div className="border border-border-default rounded-lg p-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[13px] font-semibold text-text-primary">Team ceiling</h3>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-[12px] text-text-secondary">Allow workspaces to enable this role</span>
          <input
            type="checkbox"
            checked={!killSwitchOff}
            onChange={e => setKillSwitchOff(!e.target.checked)}
            className="rounded border-border-default"
          />
        </label>
      </div>
      <p className="text-[12px] text-text-muted mb-3">
        A kill switch and a capability/scope ceiling for every workspace. Turning it off disables Operator everywhere,
        even a workspace that already opted in. Nothing here enables Operator by itself — each workspace still opts in below.
      </p>

      <div className={killSwitchOff ? 'opacity-50 pointer-events-none' : ''}>
        <div className="mb-3">
          <span className="block text-[12px] font-medium text-text-primary mb-1.5">Deploy / use capabilities</span>
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

        <p className="text-[11px] text-text-muted">
          Secret management and reveal authority can only be granted per workspace, never at the team level.
        </p>
      </div>

      {error && <div className="mt-3 px-3 py-2 rounded-md bg-status-error/10 text-status-error text-[12px]">{error}</div>}

      <div className="flex items-center gap-3 pt-3 mt-3 border-t border-border-default">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1.5 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save team ceiling'}
        </button>
      </div>
    </div>
  );
}

/** One workspace's own opt-in: enabled state, capabilities (standard + elevated, visually split), and scope. */
function WorkspaceGrantRow({
  roleId,
  workspace,
  override,
  teamMetadata,
  onSaved,
}: {
  roleId: string;
  workspace: WorkspaceOption;
  override: OperatorRoleRow | undefined;
  teamMetadata: unknown;
  onSaved: (override: OperatorRoleRow) => void;
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
    <div className="border border-border-default rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-2 hover:bg-surface-3 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-text-primary">{workspace.name}</span>
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] md:text-[10px] font-medium ${
              preview.enabled ? 'bg-status-success/10 text-status-success' : 'bg-surface-3 text-text-muted'
            }`}
          >
            {preview.enabled ? 'Enabled' : 'Disabled'}
          </span>
          {preview.capabilities.some(c => ELEVATED_AGENT_CAPABILITIES.has(c)) && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] md:text-[10px] font-medium bg-status-warning/10 text-status-warning">
              Elevated
            </span>
          )}
        </div>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {expanded && (
        <div className="p-4 space-y-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
              className="rounded border-border-default"
            />
            <span className="text-[13px] text-text-primary">Enabled for this workspace</span>
          </label>

          <div>
            <span className="block text-[12px] font-medium text-text-primary mb-1.5">Deploy / use</span>
            <div className="space-y-2">
              {STANDARD_CAPS.map(c => (
                <CapabilityCheckbox key={c} capability={c} checked={standardCaps.has(c)} onToggle={() => toggleStandard(c)} />
              ))}
            </div>
          </div>

          <div className="p-3 rounded-md border border-status-warning/30 bg-status-warning/5">
            <span className="block text-[12px] font-medium text-status-warning mb-1.5">
              Secret management &amp; reveal — off by default
            </span>
            <p className="text-[11px] text-text-muted mb-2">
              Separate from deploy/use above: this lets the agent change or read a credential's plaintext, not just use
              it server-side. Grant it only when a workspace specifically needs it.
            </p>
            <div className="space-y-2">
              {ELEVATED_CAPS.map(c => (
                <CapabilityCheckbox key={c} capability={c} checked={elevatedCaps.has(c)} onToggle={() => toggleElevated(c)} elevated />
              ))}
            </div>
          </div>

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

          {error && <div className="px-3 py-2 rounded-md bg-status-error/10 text-status-error text-[12px]">{error}</div>}

          <div className="flex items-center gap-3 pt-2 border-t border-border-default">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save workspace grant'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function OperatorAccessSection({
  roleId,
  teamMetadata,
  overrides,
  workspaces,
}: {
  roleId: string;
  teamMetadata: unknown;
  overrides: OperatorRoleRow[];
  workspaces: WorkspaceOption[];
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
    <div className="border-t border-border-default pt-8 space-y-6">
      <div>
        <h2 className="text-[15px] font-semibold text-text-primary">Platform Operator access</h2>
        <p className="text-[12px] text-text-muted mt-0.5">
          What the Operator role may do, per workspace. Deploy/use capabilities are separate from secret
          management/reveal authority, which is off by default and must be granted explicitly per workspace. No
          credential value is ever shown here — only the reference it was registered under.
        </p>
      </div>

      <TeamCeilingCard roleId={roleId} metadata={teamMetadata} />

      {workspaces.length === 0 ? (
        <p className="text-[13px] text-text-muted">No workspaces to configure yet.</p>
      ) : (
        <div className="space-y-3">
          {workspaces.map(ws => (
            <WorkspaceGrantRow
              key={ws.id}
              roleId={roleId}
              workspace={ws}
              override={overrideList.find(o => o.workspaceId === ws.id)}
              teamMetadata={teamMetadata}
              onSaved={handleSaved}
            />
          ))}
        </div>
      )}
    </div>
  );
}
