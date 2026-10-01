/**
 * The Cloudflare token's state on Settings → Runners, one word per state and
 * one next step each. Pure and client-safe: the credential view is the masked
 * metadata `GET /api/cloudflare/credential` returns, never the token.
 *
 * Whether a cloud runner is deployed, or which workspaces dispatch to it, is
 * not something this page reads, so there is no "deployed" state: a verified
 * token's next step is the deploy command.
 */

/** Masked metadata from GET /api/cloudflare/credential. Never the token. */
export interface CloudflareCredentialView {
  id: string;
  accountId: string | null;
  aiGatewayId: string | null;
  tokenHint: string | null;
  readable: boolean;
  healthStatus: 'healthy' | 'degraded' | 'revoked' | 'unknown';
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  createdAt: string;
}

export type CloudflareStateKind = 'empty' | 'unverified' | 'verified' | 'degraded' | 'rejected' | 'unreadable';

export interface CloudflareState {
  kind: CloudflareStateKind;
  /** The status chip. */
  chip: string;
  tone: 'ok' | 'warn' | 'err' | 'idle';
  /** The one next step, as a button label. */
  next: 'Add token' | 'Verify' | 'Replace' | 'Deploy';
}

export function cloudflareState(cred: CloudflareCredentialView | null): CloudflareState {
  if (!cred) return { kind: 'empty', chip: 'Not set up', tone: 'idle', next: 'Add token' };
  if (!cred.readable) return { kind: 'unreadable', chip: 'Unreadable', tone: 'err', next: 'Replace' };
  switch (cred.healthStatus) {
    case 'healthy': return { kind: 'verified', chip: 'Verified', tone: 'ok', next: 'Deploy' };
    case 'revoked': return { kind: 'rejected', chip: 'Rejected', tone: 'err', next: 'Replace' };
    case 'degraded': return { kind: 'degraded', chip: 'Degraded', tone: 'warn', next: 'Verify' };
    default: return { kind: 'unverified', chip: 'Not verified', tone: 'warn', next: 'Verify' };
  }
}

/** The deploy step from apps/cloud-runner/README.md, for a verified token. */
export const CLOUD_RUNNER_DEPLOY_COMMAND = [
  'export BUILDD_API_KEY=bld_...          # admin key',
  'export BUILDD_RUNNER_API_KEY=bld_...   # worker key for the containers',
  'bun apps/cloud-runner/scripts/deploy.ts --workspace my-workspace --dry-run',
  'bun apps/cloud-runner/scripts/deploy.ts --workspace my-workspace',
].join('\n');
