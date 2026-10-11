'use client';

/**
 * `?state=operator-access`: team settings → Platform Operator access
 * (OperatorAccessSection.tsx), reached in the real app only once a team has
 * the `operator` role row, which late-created rows never acquire on their
 * own (page.tsx lazily backfills it, but only when writes are allowed — not
 * in the read-only visual-QA clone). Mounted directly with fixture data so
 * the section is reviewable without a database.
 */
import { OperatorAccessSection } from '../../(protected)/settings/roles/[slug]/edit/OperatorAccessSection';

const WORKSPACES = [
  { id: 'ws-staging-desk', name: 'Staging Desk' },
  { id: 'ws-growth', name: 'Growth' },
  { id: 'ws-platform', name: 'Platform' },
];

const TEAM_METADATA = {
  routing: { disabled: true },
  operator: {
    capabilities: ['deployments:read', 'deployments:write', 'deployment_secrets:use'],
    scope: { providers: ['cloudflare', 'vercel'] },
  },
};

const OVERRIDES = [
  {
    id: 'override-staging-desk',
    workspaceId: 'ws-staging-desk',
    metadata: {
      operator: {
        enabled: true,
        capabilities: ['deployments:read', 'deployments:write', 'deployment_secrets:use'],
        scope: {
          providers: ['cloudflare'],
          projects: ['model-policy', 'cloud-runner'],
          environments: ['staging'],
          credentialRefs: ['cloudflare-staging'],
        },
      },
    },
  },
  {
    id: 'override-growth',
    workspaceId: 'ws-growth',
    metadata: {
      operator: {
        enabled: true,
        capabilities: ['deployments:read', 'deployments:write', 'deployment_secrets:use', 'secrets:reveal'],
        scope: {
          providers: ['vercel'],
          projects: ['marketing-site'],
          environments: ['production'],
          credentialRefs: ['vercel-prod'],
        },
      },
    },
  },
  // ws-platform has no override row: the "no opt-in yet" state.
];

export default function OperatorAccessFixture() {
  return (
    <div className="min-h-screen bg-surface-1 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-xl font-bold text-text-primary mb-1">Platform Operator access (fixture)</h1>
        <p className="text-body text-text-muted mb-6">
          Team ceiling, plus three workspaces: one enabled with standard capabilities only, one enabled with secret
          reveal also granted, one never opted in.
        </p>
        <OperatorAccessSection
          roleId="fixture-operator-role"
          teamMetadata={TEAM_METADATA}
          overrides={OVERRIDES}
          workspaces={WORKSPACES}
        />
      </div>
    </div>
  );
}
