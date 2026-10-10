'use client';

import { StatusChip } from '../_components/ConnectionRow';
import { cloudflareState } from '../_lib/cloudflare-state';
import { useCloudflareCredential } from '../_lib/use-cloudflare-credential';

/**
 * The fleet's cloud-runner row: whether the team's Cloudflare token is stored
 * and verified, and the one next step, which lives in the Cloudflare row
 * under Connections (`#cloudflare`).
 */
export default function CloudRunnerRow({ teamId }: { teamId: string }) {
  const { cred, loaded } = useCloudflareCredential(teamId);
  const state = cloudflareState(cred);
  return (
    <li data-testid="fleet-cloud-row" data-state={loaded ? state.kind : 'loading'} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="text-sm font-semibold text-text-primary">Cloud runner</span>
          {loaded && <StatusChip tone={state.tone}>{state.chip}</StatusChip>}
        </div>
        <div className="mt-1 truncate text-meta text-text-muted">Each task gets its own environment</div>
      </div>
      {loaded && (
        <a href="#cloudflare" className="btn shrink-0">
          {state.kind === 'empty' ? 'Set up' : state.next}
        </a>
      )}
    </li>
  );
}
