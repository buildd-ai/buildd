/**
 * MCP `manage_providers`: list, set, delete, explain and set_policy over
 * `/api/providers` (the one write path for model credentials). Text renderers;
 * the route holds the permission checks, and nothing here ever echoes a value.
 *
 * Who may call what (checked by `providersRefusal` before any request):
 * - list, explain: any worker-level caller, task tokens included (the route
 *   confines one to its own workspace).
 * - set, delete with scope `mine`: a signed-in person (an OAuth MCP session).
 *   A task token or API key has no person and is refused with a reason.
 * - set, delete with scope `team` / `workspace`, and set_policy: admin level.
 */
import type { ActionContext, ApiFn } from './mcp-tools';

export type ProvidersOp = 'list' | 'set' | 'delete' | 'explain' | 'set_policy';

export const PROVIDERS_SURFACES = ['chat', 'agent-claude', 'agent-codex', 'cloud-egress'] as const;

/** The scope a set/delete addresses when none is given: a person's own, else the team's. */
export function defaultProvidersScope(ctx: Pick<ActionContext, 'principal'>): 'mine' | 'team' {
  return ctx.principal === 'person' ? 'mine' : 'team';
}

/** Is this an admin-only call? */
export function providersNeedsAdmin(op: ProvidersOp, scope: string | undefined): boolean {
  return op === 'set_policy' || ((op === 'set' || op === 'delete') && scope !== 'mine');
}

type Summary = {
  shape: string; scope: string; purpose: string; label: string | null; legacy: boolean; last4: string | null;
  health: string; lastVerifiedAt: string | null; servesToday: string[]; endpointKind?: string; accountScoped?: boolean;
};

function describeRow(s: Summary): string {
  const key = s.last4 === null ? 'connected seat' : s.last4 ? `…${s.last4}` : 'key unreadable';
  const where = s.purpose === 'inference_key' && s.label ? `${s.purpose}/${s.label}` : s.purpose;
  const tags = [s.shape, where, s.legacy ? 'legacy storage' : '', s.endpointKind ? `routes ${s.endpointKind}` : '', s.accountScoped ? 'one account only' : '']
    .filter(Boolean).join(', ');
  const verified = s.lastVerifiedAt ? `, verified ${s.lastVerifiedAt.slice(0, 16).replace('T', ' ')}` : '';
  return `${key} ${s.health}${verified} (${tags}) — serves ${s.servesToday.join(', ') || 'nothing yet'}`;
}

function scopeLine(name: string, rows: Summary[] | null): string | null {
  if (rows === null) return null;
  return rows.length === 0 ? `  ${name}: —` : rows.map((r, i) => `  ${i === 0 ? name : ' '.repeat(name.length)}: ${describeRow(r)}`).join('\n');
}

function renderList(data: any): string {
  const p = data.policy ?? {};
  const lines = [
    `Credential policy: ${p.credentialPolicy ?? 'not set'} (chat follows ${p.chat?.policy}; agent runs ${p.agent?.enforced ? `follow ${p.agent.policy}` : 'use team credentials until a policy is set'}).`,
    `You: ${data.caller?.principal}${data.caller?.canSetMine ? ', can set your own (scope mine)' : ', cannot hold a personal credential'}.`,
    '',
  ];
  for (const prov of data.providers ?? []) {
    const serves = Object.entries(prov.surfaces ?? {}).filter(([, v]: any) => v.ok).map(([k]) => k);
    const nots = Object.entries(prov.surfaces ?? {}).filter(([, v]: any) => !v.ok).map(([k, v]: any) => `${k} (${v.reason})`);
    lines.push(`- **${prov.label}** (\`${prov.id}\`): serves ${serves.join(', ') || 'nothing'}${nots.length ? `; not ${nots.join('; ')}` : ''}`);
    if (prov.scopes?.mine && !prov.scopes.mine.ok) lines.push(`  mine: closed — ${prov.scopes.mine.reason}`);
    for (const l of [scopeLine('team', prov.set?.team ?? []), scopeLine('workspace', prov.set?.workspace ?? null), prov.scopes?.mine?.ok ? scopeLine('mine', prov.set?.mine ?? null) : null]) {
      if (l) lines.push(l);
    }
  }
  return lines.join('\n');
}

function qs(entries: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(entries)) if (typeof v === 'string' && v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * The action, after level and principal checks. `workspaceId` is already
 * resolved (UUID) or null.
 */
export async function handleProvidersAction(
  api: ApiFn,
  op: ProvidersOp,
  params: Record<string, unknown>,
  workspaceId: string | null,
  scope: string | undefined,
): Promise<string> {
  const provider = typeof params.provider === 'string' ? params.provider : undefined;
  switch (op) {
    case 'list':
      return renderList(await api(`/api/providers${qs({ workspaceId })}`));

    case 'set': {
      if (!provider) throw new Error('provider is required for set (anthropic, claude-subscription, openai, codex-subscription, openrouter, litellm, custom-endpoint)');
      const body: Record<string, unknown> = { provider, scope, ...(workspaceId && scope === 'workspace' ? { workspaceId } : {}) };
      for (const k of ['shape', 'value', 'config', 'surface'] as const) if (params[k] !== undefined) body[k] = params[k];
      const data = await api('/api/providers', { method: 'PUT', body: JSON.stringify(body) });
      const rows = (data.credentials ?? []) as Summary[];
      return [
        `Saved ${provider} at ${scope}${data.workspaceId ? ` (${data.workspaceId})` : ''}.`,
        ...rows.map(r => `- ${describeRow(r)}`),
        ...(data.requeued ? [`Requeued ${data.requeued} task(s) that had failed on the old credential.`] : []),
      ].join('\n');
    }

    case 'delete': {
      if (!provider) throw new Error('provider is required for delete');
      const data = await api(`/api/providers${qs({ provider, scope, shape: params.shape, workspaceId: scope === 'workspace' ? workspaceId : null })}`, { method: 'DELETE' });
      const left = (data.credentials ?? []) as Summary[];
      return `Removed ${data.deleted ?? 0} ${provider} credential row(s) at ${scope}.${left.length ? ` Still set there:\n${left.map(r => `- ${describeRow(r)}`).join('\n')}` : ''}`;
    }

    case 'explain': {
      const surface = params.surface;
      if (typeof surface !== 'string' || !(PROVIDERS_SURFACES as readonly string[]).includes(surface)) {
        throw new Error(`surface is required for explain: ${PROVIDERS_SURFACES.join(', ')}`);
      }
      const data = await api(`/api/providers/explain${qs({ surface, provider, workspaceId, as: params.as })}`);
      const r = data.result ?? {};
      const head = r.resolved
        ? `${surface} (${data.as === 'self' ? 'your work' : 'team work'}) → ${r.provider} ${r.shape}, ${r.scope}${r.source?.secretId ? ` row ${r.source.secretId}` : ''}${r.source?.purpose ? ` (${r.source.purpose}${r.source.legacy ? ', legacy' : ''})` : ''}${r.source?.envVar ? ` env ${r.source.envVar}` : ''}.`
        : `${surface} (${data.as === 'self' ? 'your work' : 'team work'}) → nothing resolves (${r.reason}).`;
      return [head, 'Why:', ...((data.why ?? []) as string[]).map(w => `- ${w}`)].join('\n');
    }

    case 'set_policy': {
      const policy = params.policy;
      if (policy !== 'team' && policy !== 'personal_first' && policy !== 'personal_only') {
        throw new Error('policy is required: team | personal_first | personal_only');
      }
      const data = await api('/api/providers', { method: 'PATCH', body: JSON.stringify({ credentialPolicy: policy }) });
      return `Credential policy set to ${data.policy?.credentialPolicy ?? policy}. Chat and agent runs now follow it.`;
    }
  }
}
