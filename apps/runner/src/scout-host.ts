/**
 * Runner-side Quality Scout host (design artifact `quality-scout-runner-host`
 * §6-7, slice 1). An idle runner claims a parked Scout run whose command
 * probes need a runner, runs them in a sandboxed throwaway checkout of the
 * exact SHA, and posts the substrate results; the server finalizes.
 *
 * Modelled on KnowledgeIngestPoller: polled only on the idle heartbeat tick
 * (`active === 0 && !singleTask`), one run at a time, never a worker slot, no
 * model, no OAuth budget. A repo whose clone cannot fetch the SHA is left out
 * of claim offers for a back-off.
 *
 * Sandbox: a runner hosts command probes only when it can wrap them in bwrap
 * (`isMountIsolationBwrapSupported`), or the operator of a single-tenant host
 * set BUILDD_SCOUT_UNSANDBOXED=1. Otherwise it neither advertises
 * `environment.scoutHost` nor claims, so the server says `no_runner_host`.
 * BUILDD_SCOUT_HOST=0 opts a runner out entirely.
 */
import * as os from 'os';
import { join, resolve } from 'path';
import * as fs from 'fs';
import {
  createScoutHostHttpApi,
  hostClaimedScoutRun,
  type HostScoutRunOptions,
  type ScoutClaimed,
  type ScoutHostApi,
} from '@buildd/core/quality-scout/runner-host';
import type { WorkerEnvironment } from '@buildd/shared';
import { buildWorkerBwrapArgv } from './bwrap-mount-allowlist';
import type { LocalRepo } from './knowledge-ingest';

export type ScoutSandbox =
  | { mode: 'bwrap' }
  | { mode: 'unsandboxed' }
  | { mode: null; reason: 'opted_out' | 'no_sandbox' };

/**
 * Can this runner host Scout command probes, and how. Never `unsandboxed`
 * without the operator's explicit BUILDD_SCOUT_UNSANDBOXED=1.
 */
export function resolveScoutSandbox(env: NodeJS.ProcessEnv, bwrapSupported: () => boolean): ScoutSandbox {
  if (env.BUILDD_SCOUT_HOST === '0') return { mode: null, reason: 'opted_out' };
  if (bwrapSupported()) return { mode: 'bwrap' };
  if (env.BUILDD_SCOUT_UNSANDBOXED === '1') return { mode: 'unsandboxed' };
  return { mode: null, reason: 'no_sandbox' };
}

/** `environment.scoutHost` for the heartbeat, or undefined when this runner cannot host. */
export function scoutHostAdvert(sandbox: ScoutSandbox, repos: readonly string[], capture = false): WorkerEnvironment['scoutHost'] {
  if (sandbox.mode === null || repos.length === 0) return undefined;
  return { repos: [...repos], command: true, capture };
}

/**
 * Surface probes: capture runs on GitHub's runner through `visual-qa.yml`,
 * so it needs no local browser, only the run-scoped token a claim hands a
 * trusted host-runner key. On by default; BUILDD_SCOUT_CAPTURE=0 opts out.
 */
export function resolveScoutCapture(env: NodeJS.ProcessEnv): boolean {
  return env.BUILDD_SCOUT_CAPTURE !== '0';
}

export interface ScoutBwrapContext {
  worktree: string;
  home: string;
  repoPath: string;
  /** The runner's own bun install (read-only), so `bun` on PATH resolves inside. */
  bunInstallPath?: string;
  /** BUILDD_SCOUT_MOUNT_EXTRA: extra read-only (or `:rw`) host paths, e.g. a toolchain dir. */
  extraMounts?: string;
  pathExists?: (p: string) => boolean;
}

/**
 * The bwrap argv around one probe command. The worktree and the probe's temp
 * home are read-write (both disposable); the clone's `.git` is read-only; the
 * runner's real home, `~/.buildd`, `~/.claude`, `~/.config/gh` are never
 * mounted, because the home the worker argv derives from is the probe's.
 */
export function buildScoutBwrapArgv(ctx: ScoutBwrapContext): string[] {
  const home = resolve(ctx.home);
  const bunInstall = resolve(ctx.bunInstallPath ?? join(os.homedir(), '.bun'));
  const extra = [`${home}:rw`, ...(ctx.extraMounts ? [ctx.extraMounts] : [])].join(',');
  const argv = buildWorkerBwrapArgv({
    worktreePath: ctx.worktree,
    repoPath: ctx.repoPath,
    homePath: home,
    bunInstallPath: bunInstall,
    isCodexTask: false,
    extraMounts: extra,
    pathExists: ctx.pathExists,
    warn: () => {},
  });
  const gitDir = resolve(ctx.repoPath, '.git');
  const bunCache = join(bunInstall, 'install', 'cache');
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--bind' || a === '--ro-bind') && i + 2 < argv.length) {
      const src = argv[i + 1];
      // The runner's shared bun cache stays out of reach (the probe's own is under its HOME).
      if (src === bunCache) { i += 2; continue; }
      // A probe reads the clone's objects; it never writes them.
      out.push(src === gitDir ? '--ro-bind' : a, src, argv[i + 2]);
      i += 2;
      continue;
    }
    out.push(a);
  }
  // Dropping the cache's own rw bind is not enough: it sits inside the read-only
  // bunInstall bind, so it stays readable. Mask it with an empty tmpfs (bwrap
  // applies mounts in order, so this lands on top). Only when it exists: a
  // missing mountpoint cannot be created inside the read-only parent.
  if ((ctx.pathExists ?? fs.existsSync)(bunCache)) out.push('--tmpfs', bunCache);
  // The worker argv puts operator mounts last; ours too. Then the probe starts in its worktree.
  out.push('--chdir', resolve(ctx.worktree));
  return out;
}

export type ScoutPollOutcome = 'disabled' | 'no_sandbox' | 'busy' | 'idle' | 'ran' | 'released' | 'error';

/** How long a repo whose clone could not serve a run's SHA is left out of claim offers. */
export const SCOUT_UNFETCHABLE_BACKOFF_MS = 30 * 60 * 1000;

export interface ScoutHostPollerOptions {
  api: ScoutHostApi;
  scanRepos: () => LocalRepo[];
  /** Resolved per poll, so a bwrap probe that changes or an env flip is honoured. */
  sandbox: () => ScoutSandbox;
  /** True while the runner has any working worker. Checked before claiming and again before checking out. */
  isBusy: () => boolean;
  /** Offer `ports.capture` (surface probes). Default false. */
  capture?: () => boolean;
  runnerId?: string;
  /** Injectable for tests; default `hostClaimedScoutRun`. */
  hostRun?: (opts: HostScoutRunOptions) => ReturnType<typeof hostClaimedScoutRun>;
  /** Passed through to `hostClaimedScoutRun` (tests: fake checkout check, tmp root). */
  hostOptions?: Partial<Omit<HostScoutRunOptions, 'claimed' | 'repoPath' | 'api' | 'wrapFor'>>;
  /** bwrap context extras (bun install, operator mounts). */
  bwrap?: Pick<ScoutBwrapContext, 'bunInstallPath' | 'extraMounts' | 'pathExists'>;
  log?: (msg: string) => void;
  now?: () => number;
}

export class ScoutHostPoller {
  private running = false;
  private readonly backoff = new Map<string, number>();

  constructor(private readonly opts: ScoutHostPollerOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** `owner/name` of local clones not in back-off. */
  offerableRepos(): Array<{ slug: string; path: string }> {
    const now = this.now();
    const out = new Map<string, string>();
    for (const r of this.opts.scanRepos()) {
      if (!r.normalizedUrl) continue;
      const slug = r.normalizedUrl.toLowerCase();
      if ((this.backoff.get(slug) ?? 0) > now) continue;
      if (!out.has(slug)) out.set(slug, r.path);
    }
    return [...out].map(([slug, path]) => ({ slug, path }));
  }

  /** The heartbeat advert (`environment.scoutHost`), or undefined. */
  advert(): WorkerEnvironment['scoutHost'] {
    return scoutHostAdvert(this.opts.sandbox(), this.offerableRepos().map((r) => r.slug), this.opts.capture?.() === true);
  }

  /** Claim and host at most one Scout run. Never throws. */
  async poll(): Promise<ScoutPollOutcome> {
    const sandbox = this.opts.sandbox();
    if (sandbox.mode === null) return sandbox.reason === 'opted_out' ? 'disabled' : 'no_sandbox';
    if (this.running || this.opts.isBusy()) return 'busy';
    this.running = true;
    const log = this.opts.log ?? ((m: string) => console.log(m));
    try {
      const repos = this.offerableRepos();
      if (repos.length === 0) return 'idle';
      const claim = await this.opts.api.claim({
        repos: repos.map((r) => r.slug),
        ports: { command: true, capture: this.opts.capture?.() === true, browser: false },
        ...(this.opts.runnerId ? { runnerId: this.opts.runnerId } : {}),
      });
      if (!claim.run) return 'idle';
      const claimed = claim as ScoutClaimed;
      const slug = claimed.repo?.toLowerCase() ?? (repos.length === 1 ? repos[0].slug : null);
      const repoPath = slug ? repos.find((r) => r.slug === slug)?.path : undefined;
      if (!repoPath) {
        await this.opts.api.release(claimed.run.id, claimed.lease.leaseId, 'runner has no clone of the run\'s repo').catch(() => false);
        return 'released';
      }
      // A real task arrived between the claim and now: hand the run back rather than compete with it.
      if (this.opts.isBusy()) {
        await this.opts.api.release(claimed.run.id, claimed.lease.leaseId, 'runner became busy').catch(() => false);
        return 'released';
      }

      log(`[scout-host] run ${claimed.run.id.slice(0, 8)} for ${slug} @ ${claimed.run.candidate.sha.slice(0, 12)} (${claimed.probes.length} probe(s), ${sandbox.mode})`);
      const host = this.opts.hostRun ?? hostClaimedScoutRun;
      const bwrapExtras = this.opts.bwrap ?? {};
      const out = await host({
        ...this.opts.hostOptions,
        claimed,
        repoPath,
        api: this.opts.api,
        wrapFor: sandbox.mode === 'bwrap'
          ? (ctx) => {
            const argv = buildScoutBwrapArgv({ ...ctx, ...bwrapExtras });
            return (cmd) => ['bwrap', ...argv, '--', ...cmd];
          }
          : undefined,
        log,
      });
      if (out.status === 'released') {
        if (out.unfetchable && slug) this.backoff.set(slug, this.now() + SCOUT_UNFETCHABLE_BACKOFF_MS);
        return 'released';
      }
      log(`[scout-host] run ${claimed.run.id.slice(0, 8)}: posted ${out.posted.length}/${claimed.probes.length}${out.fixtureFailed ? ' (fixture setup failed: inconclusive)' : ''}${out.finalized ? ', finalized' : ''}${out.stopped ? `, stopped: ${out.stopped}` : ''}`);
      return 'ran';
    } catch (err) {
      log(`[scout-host] poll failed: ${err instanceof Error ? err.message : err}`);
      return 'error';
    } finally {
      this.running = false;
    }
  }
}

/** The runner's own secret values, so a probe excerpt can never echo one back. */
function runnerSecretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([k, v]) => !!v && /(TOKEN|SECRET|PASSWORD|API_KEY|_KEY$)/i.test(k))
    .map(([, v]) => v as string);
}

/** Wire-up used by the WorkerManager. */
export function createScoutHostPoller(config: {
  builddServer: string;
  apiKey: string;
  scanRepos: () => LocalRepo[];
  bwrapSupported: () => boolean;
  isBusy: () => boolean;
  runnerId?: string;
}): ScoutHostPoller {
  // Throwaway checkouts live outside /tmp: bwrap mounts a fresh tmpfs there.
  // Created on first use by hostClaimedScoutRun, never at construction.
  let tmpRoot: string | undefined;
  try { tmpRoot = join(os.homedir(), '.cache', 'buildd-scout'); } catch { /* falls back to os.tmpdir() */ }
  return new ScoutHostPoller({
    api: createScoutHostHttpApi({ serverUrl: config.builddServer, apiKey: config.apiKey }),
    scanRepos: config.scanRepos,
    sandbox: () => resolveScoutSandbox(process.env, config.bwrapSupported),
    isBusy: config.isBusy,
    capture: () => resolveScoutCapture(process.env),
    runnerId: config.runnerId,
    hostOptions: { secretValues: runnerSecretValues(process.env), tmpRoot },
    bwrap: { extraMounts: process.env.BUILDD_SCOUT_MOUNT_EXTRA, pathExists: (p) => fs.existsSync(p) },
  });
}
