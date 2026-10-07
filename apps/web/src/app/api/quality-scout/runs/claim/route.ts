/**
 * POST /api/quality-scout/runs/claim — a runner leases a parked Quality Scout
 * run (status `awaiting_host`) whose runner-assigned probes it can host.
 * Design: artifact `quality-scout-runner-host` §4.
 *
 * Body (ScoutRunClaimRequest): { repos: string[] (owner/name of its clones),
 * ports: { command, capture, browser, appBoot? }, runnerId? }.
 *
 * Only runs in the key's team, in a workspace it may claim in, whose repo is
 * in `repos` and whose every runner probe the ports serve. Before claiming,
 * expired parked runs of those workspaces are finalized (never `pass`). The
 * lease is an atomic UPDATE … WHERE status='awaiting_host' AND lease free …
 * RETURNING, so concurrent runners race safely. The fleet kill switch
 * (QUALITY_SCOUT_DISABLED) stops claims, not the sweep.
 *
 * Response (ScoutRunClaimResponse): the run, its runner probes, the frozen
 * profile and the lease (leaseId + expiry), or { run: null, reason }.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { claimScoutRunForRunner, parseScoutHostPorts } from '@/lib/quality-scout-runner-host';
import { dbScoutRunnerHostStore } from '@/lib/quality-scout-runner-host-store';
import { isQualityScoutDisabled } from '@/lib/quality-scout-trigger';
import { fail, NO_STORE, resolveScoutHostCaller } from '../caller';

export async function POST(req: NextRequest) {
  const auth = await resolveScoutHostCaller(req);
  if (!auth.ok) return auth.response;

  let body: { repos?: unknown; ports?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  const repos = body?.repos;
  if (!Array.isArray(repos) || repos.length === 0 || !repos.every((r) => typeof r === 'string')) {
    return fail(400, 'repos (non-empty string array) is required');
  }
  const ports = parseScoutHostPorts(body.ports);
  if (!ports) return fail(400, 'ports ({ command, capture, browser } booleans) is required');

  const result = await claimScoutRunForRunner(
    {
      caller: auth.caller,
      repos: repos as string[],
      ports,
      now: new Date(),
      disabled: isQualityScoutDisabled(),
      newLeaseId: randomUUID,
    },
    dbScoutRunnerHostStore,
  );
  return NextResponse.json(result, { headers: NO_STORE });
}
