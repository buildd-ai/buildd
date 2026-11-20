/**
 * A Cedar policy decision point for the connector gateway (see connector-pdp.ts).
 *
 * Policies are written against this request shape, namespace `Buildd`:
 *
 *   principal  Buildd::AgentRun::"<workerId>"
 *                in Buildd::Workspace::"<id>", Buildd::Team::"<id>", Buildd::Role::"<roleSlug>"
 *                attrs: task, workspace, team?, role?, account, via, unattended (bool)
 *   action     Buildd::Action::"read" | "query"            in Buildd::Action::"callTool"
 *              Buildd::Action::"write" | "admin"           in Buildd::Action::"mutate" in "callTool"
 *   resource   Buildd::Tool::"<connectorId>/<tool>"
 *                in Buildd::Connector::"<connectorId>" in Buildd::Provider::"<provider>"
 *                attrs: name, connector, provider
 *   context    risk, environment?, scopeResource?, grantBasis? ("role_mount" | "grant",
 *              when an earlier PDP in the chain allowed the call)
 *
 * Example:
 *   @id("no-production-writes")
 *   forbid(principal, action in Buildd::Action::"mutate", resource)
 *   when { context has environment && context.environment == "production" };
 *
 * Cedar's own semantics: a matching forbid wins; otherwise a matching permit
 * allows; no matching policy denies. A policy's `@id("…")` names it in the
 * decision and the audit row (else `policy<N>`, its position in the text).
 * A tool an admin turned off (`denied`) is refused before Cedar is asked.
 */
import { isAuthorized, policySetTextToParts, policyToJson, checkParsePolicySet } from '@cedar-policy/cedar-wasm/nodejs';
import type { CedarValueJson, EntityJson, TypeAndId } from '@cedar-policy/cedar-wasm/nodejs';
import type { PolicyDecision, PolicyDecisionPoint, PolicyRequest } from './connector-pdp';

const NS = 'Buildd';
const uid = (type: string, id: string): TypeAndId => ({ type: `${NS}::${type}`, id });

const ACTION_GROUPS: EntityJson[] = [
  { uid: uid('Action', 'callTool'), attrs: {}, parents: [] },
  { uid: uid('Action', 'mutate'), attrs: {}, parents: [uid('Action', 'callTool')] },
  { uid: uid('Action', 'read'), attrs: {}, parents: [uid('Action', 'callTool')] },
  { uid: uid('Action', 'query'), attrs: {}, parents: [uid('Action', 'callTool')] },
  { uid: uid('Action', 'write'), attrs: {}, parents: [uid('Action', 'mutate')] },
  { uid: uid('Action', 'admin'), attrs: {}, parents: [uid('Action', 'mutate')] },
];

/** The Cedar request and entity store for one gateway request. Absent facts are omitted, never null. */
export function cedarEntities(req: PolicyRequest): {
  principal: TypeAndId; action: TypeAndId; resource: TypeAndId;
  entities: EntityJson[]; context: Record<string, CedarValueJson>;
} {
  const p = req.principal;
  const r = req.resource;
  const principal = uid('AgentRun', p.workerId);
  const parents: TypeAndId[] = [uid('Workspace', p.workspaceId)];
  if (p.teamId) parents.push(uid('Team', p.teamId));
  if (p.roleSlug) parents.push(uid('Role', p.roleSlug));
  const attrs: Record<string, CedarValueJson> = {
    task: p.taskId, workspace: p.workspaceId, account: p.accountId, via: p.via, unattended: p.unattended,
    ...(p.teamId ? { team: p.teamId } : {}),
    ...(p.roleSlug ? { role: p.roleSlug } : {}),
  };
  const resource = uid('Tool', `${r.connectorId}/${r.tool}`);
  const context: Record<string, CedarValueJson> = { risk: req.action.risk };
  if (r.scope.environment) context.environment = r.scope.environment;
  if (r.scope.resource) context.scopeResource = r.scope.resource;
  const prior = req.context.prior;
  if (prior?.effect === 'allow' && prior.reason !== 'policy') context.grantBasis = prior.reason;
  const entities: EntityJson[] = [
    ...ACTION_GROUPS,
    { uid: principal, attrs, parents },
    { uid: uid('Workspace', p.workspaceId), attrs: {}, parents: p.teamId ? [uid('Team', p.teamId)] : [] },
    ...(p.teamId ? [{ uid: uid('Team', p.teamId), attrs: {}, parents: [] }] : []),
    ...(p.roleSlug ? [{ uid: uid('Role', p.roleSlug), attrs: {}, parents: [] }] : []),
    { uid: resource, attrs: { name: r.tool, connector: r.connectorId, provider: r.provider }, parents: [uid('Connector', r.connectorId)] },
    { uid: uid('Connector', r.connectorId), attrs: {}, parents: [uid('Provider', r.provider)] },
    { uid: uid('Provider', r.provider), attrs: {}, parents: [] },
  ];
  return { principal, action: uid('Action', req.action.risk), resource, entities, context };
}

const messages = (errors: { message: string }[]) => errors.map(e => e.message).join('; ').slice(0, 300);

/**
 * Split Cedar text into policies keyed by their `@id` annotation (or
 * `policy<N>`). Throws on text that does not parse or on a duplicate id, so a
 * bad policy set stops the gateway rather than silently allowing or denying.
 */
function policiesById(text: string): Record<string, string> {
  const parts = policySetTextToParts(text);
  if (parts.type === 'failure') throw new Error(`Cedar policies do not parse: ${messages(parts.errors)}`);
  if (parts.policy_templates.length) throw new Error('Cedar policy templates are not supported here');
  const byId: Record<string, string> = {};
  parts.policies.forEach((policy, i) => {
    const json = policyToJson(policy);
    if (json.type === 'failure') throw new Error(`Cedar policy ${i} does not parse: ${messages(json.errors)}`);
    const annotated = json.json.annotations?.id;
    const id = typeof annotated === 'string' && annotated ? annotated : `policy${i}`;
    if (id in byId) throw new Error(`Cedar policies have a duplicate id: ${id}`);
    byId[id] = policy;
  });
  const checked = checkParsePolicySet({ staticPolicies: byId });
  if (checked.type === 'failure') throw new Error(`Cedar policies do not parse: ${messages(checked.errors)}`);
  return byId;
}

export function cedarPdp(text: string): PolicyDecisionPoint {
  const staticPolicies = policiesById(text);
  return {
    id: 'cedar',
    async decide(req): Promise<PolicyDecision> {
      if (req.action.risk === 'denied') return { effect: 'deny', reason: 'tool_denied_by_admin' };
      const { principal, action, resource, entities, context } = cedarEntities(req);
      const answer = isAuthorized({ principal, action, resource, context, entities, policies: { staticPolicies } });
      if (answer.type === 'failure') throw new Error(`Cedar could not decide: ${messages(answer.errors)}`);
      const { decision, diagnostics } = answer.response;
      if (diagnostics.errors.length) {
        // A policy that errors is skipped (Cedar semantics); say which, never the request.
        console.warn(`[connector-pdp] cedar policy errors: ${diagnostics.errors.map(e => e.policyId).join(',').slice(0, 200)}`);
      }
      const policyId = [...diagnostics.reason].sort()[0];
      if (decision === 'allow') return { effect: 'allow', reason: 'policy', ...(policyId ? { policyId } : {}) };
      return { effect: 'deny', reason: 'policy_denied', ...(policyId ? { policyId } : {}) };
    },
  };
}
