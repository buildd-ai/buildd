/**
 * manage_model_tiers actions for model upgrades: policy, set_policy, adopt,
 * model. Thin text renderers over /api/model-tiers/policy and
 * /api/model-tiers/certifications; the routes hold the admin gate.
 */
import type { ActionContext, ApiFn } from './mcp-tools';
import {
  MODEL_UPGRADE_MODES,
  describeAdoption,
  type ModelUpgradePolicy,
  type PolicySource,
  type TierAdoption,
} from './model-upgrade-policy';
import type { CertificationView } from './model-certification-candidates';

type UpgradeAction = 'policy' | 'set_policy' | 'adopt' | 'model';

function describePolicy(p: ModelUpgradePolicy): string {
  switch (p.mode) {
    case 'latest-compatible':
      return 'latest-compatible (tiers move to each newly certified model as soon as it is certified)';
    case 'soak':
      return `soak ${p.soakHours ?? 72}h (tiers move once a model has been certified that long with no compatibility incident)`;
    case 'manual':
      return `manual (tiers stay on models available as of ${p.adoptedThrough?.slice(0, 16).replace('T', ' ')} UTC until someone adopts)`;
  }
}

const SOURCE_LABEL: Record<PolicySource, string> = {
  workspace: 'set on this workspace',
  team: 'set for the team',
  default: 'the default (nothing set)',
};

export async function handleModelUpgradeAction(
  api: ApiFn,
  action: UpgradeAction,
  params: Record<string, any>,
  _ctx: ActionContext,
): Promise<string> {
  // Only an explicit workspaceId scopes a policy to one workspace; the session
  // workspace would otherwise turn every "set the team's policy" into an override.
  const wsId = typeof params.workspaceId === 'string' && params.workspaceId ? params.workspaceId : null;
  const qs = new URLSearchParams();
  if (wsId) qs.set('workspaceId', wsId);

  if (action === 'model') {
    const model = typeof params.model === 'string' ? params.model.trim() : '';
    if (!model) throw new Error('model is required for action=model');
    const data = (await api(`/api/model-tiers/certifications?model=${encodeURIComponent(model)}`)) as { certification: CertificationView };
    const c = data.certification;
    const lines = [`Certification for ${c.model}: ${c.state}`];
    if (c.state === 'baseline') lines.push('Covered by Buildd\'s built-in compatibility table; no probe needed.');
    if (c.state === 'discovered') lines.push('In the live catalog but not yet probed: tiers do not use it until it is certified.');
    if (c.minCliVersion) lines.push(`Needs Claude Code ${c.minCliVersion} or newer on the runner.`);
    if (c.releasedAt) lines.push(`Released: ${c.releasedAt.slice(0, 10)}`);
    if (c.certifiedAt) lines.push(`Certified: ${c.certifiedAt.slice(0, 16).replace('T', ' ')} UTC`);
    if (c.contextLength) lines.push(`Context: ${c.contextLength.toLocaleString('en-US')} tokens`);
    if (c.deprecated) {
      lines.push(
        `${c.retired ? 'Retired' : 'Deprecated'} (${c.deprecated.source === 'admin' ? 'marked by Buildd' : 'provider catalog'})` +
          (c.deprecated.retiresAt ? `, retires ${c.deprecated.retiresAt.slice(0, 10)}` : '') +
          (c.deprecated.note ? `: ${c.deprecated.note}` : ''),
      );
    }
    if (c.lastProbe?.at) {
      lines.push(
        `Last probe: ${c.lastProbe.at.slice(0, 16).replace('T', ' ')} UTC on Claude Code ${c.lastProbe.cliVersion ?? '?'}` +
          (c.lastProbe.error ? ` — ${c.lastProbe.error}` : ' — launched OK'),
      );
    }
    return lines.join('\n');
  }

  if (action === 'set_policy') {
    const mode = params.mode;
    if (mode === 'inherit') {
      if (!wsId) {
        await api(`/api/model-tiers/policy`, { method: 'DELETE' });
        return 'Team upgrade policy cleared: workspaces without their own policy now use the default (latest-compatible).';
      }
      await api(`/api/model-tiers/policy?${qs}`, { method: 'DELETE' });
      return `Workspace ${wsId} upgrade policy cleared: it now inherits the team policy.`;
    }
    if (!MODEL_UPGRADE_MODES.includes(mode)) {
      throw new Error(`mode must be one of ${MODEL_UPGRADE_MODES.join(', ')}, or "inherit". To pin a tier to an exact model use action=set.`);
    }
    const body: Record<string, unknown> = { mode };
    if (wsId) body.workspaceId = wsId;
    if (params.soakHours != null) body.soakHours = params.soakHours;
    const data = (await api('/api/model-tiers/policy', { method: 'PUT', body: JSON.stringify(body) })) as {
      policy: ModelUpgradePolicy;
      scope: 'team' | 'workspace';
    };
    return (
      `Upgrade policy for ${data.scope === 'workspace' ? `workspace ${wsId}` : 'the team'}: ${describePolicy(data.policy)}.\n` +
      `Takes effect on the next claim (within 60s). Pinned tiers are unaffected.`
    );
  }

  if (action === 'adopt') {
    const body: Record<string, unknown> = {};
    if (wsId) body.workspaceId = wsId;
    const data = (await api('/api/model-tiers/policy/adopt', { method: 'POST', body: JSON.stringify(body) })) as {
      policy: ModelUpgradePolicy;
    };
    return `Adopted every model certified as of ${data.policy.adoptedThrough?.slice(0, 16).replace('T', ' ')} UTC. Catalog-resolved tiers move on the next claim; pinned tiers do not.`;
  }

  const data = (await api(`/api/model-tiers/policy?${qs}`)) as {
    policy: ModelUpgradePolicy;
    source: PolicySource;
    tiers: TierAdoption[];
  };
  const withheld = data.tiers.filter((t) => t.newer && t.withheld);
  return (
    `Upgrade policy: ${describePolicy(data.policy)} — ${SOURCE_LABEL[data.source]}.\n\n` +
    data.tiers.map((t) => `  ${describeAdoption(t)}`).join('\n') +
    (withheld.length
      ? `\n\n${withheld.length} tier(s) have a newer certified model withheld. ` +
        (data.policy.mode === 'manual' ? 'Adopt with action=adopt, or ' : '') +
        'switch with action=set_policy mode=latest-compatible; a pinned tier moves with action=set or delete.'
      : '')
  );
}
