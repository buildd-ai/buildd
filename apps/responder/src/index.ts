#!/usr/bin/env bun
/**
 * Entry point. Two modes, one code path:
 *
 *   bun apps/responder/src/index.ts --once     one cycle, then exit
 *   bun apps/responder/src/index.ts            long-lived, one cycle per interval
 *
 * `--once` is not a debug affordance. It is what lets the responder be driven
 * by an external scheduler that is not this process, which matters because a
 * long-lived process is itself a thing that can die quietly — and the design's
 * leaning is a host-level daemon, with the cron form available if that host is
 * the wrong place to put one. Both modes share the same cycle, so neither can
 * drift from the other.
 *
 * ── Observe-only ────────────────────────────────────────────────────────────
 * There is no `--fix`, no `--restart`, no `--rollback`, and no flag that
 * enables one. Actions are a later, separately-flagged phase and are not
 * scaffolded here: speculative action code is how an observe-only mode becomes
 * an acting one by accident.
 *
 * ── Deployment is out of scope ──────────────────────────────────────────────
 * Nothing here is wired to any infrastructure. See `apps/responder/README.md`
 * for how it should be deployed and for the properties a deployment has to
 * preserve.
 */

import { loadConfig } from './config';
import { runCycle } from './cycle';
import { buildDetectors } from './detectors';
import { loadState, saveState } from './evidence';
import { modelNarrator, noNarrator } from './narrative';
import { pushoverNotifier } from './notify';
import { observe } from './observe';

async function main(): Promise<number> {
  const once = process.argv.includes('--once');

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    // A misconfigured responder must fail loudly at start rather than run
    // half-armed. This is the one place the process exits non-zero.
    console.error(`[responder] configuration error: ${(err as Error).message}`);
    return 2;
  }

  const detectors = buildDetectors({ roleRegression: config.roleRegression });
  const notify = pushoverNotifier(config.notify);
  const narrate = config.narrative
    ? modelNarrator(config.narrative, {
        model: config.narrativeModel,
        timeoutMs: config.narrativeTimeoutMs,
      })
    : noNarrator;

  console.log(
    `[responder] observe-only. detectors=${detectors.map(d => d.id).join(',')} ` +
      `state=${config.stateDir} narrative=${config.narrative?.kind ?? 'none'} ` +
      `cronFeed=${config.cronRunsUrl ? 'configured' : 'absent'} ` +
      `mode=${once ? 'once' : `loop/${config.intervalSeconds}s`}`,
  );

  let state = loadState(config.stateDir);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  for (;;) {
    const now = Date.now();
    try {
      const observed = await observe(config, state, now);
      state = observed.state;
      const result = await runCycle({
        stateDir: config.stateDir,
        detectors,
        snapshot: observed.snapshot,
        state,
        now,
        renotifyHours: config.renotifyHours,
        notify,
        narrate,
        narrativeTimeoutMs: config.narrativeTimeoutMs,
        hasNarrativeCredential: config.narrative !== null,
      });
      state = result.state;
      const summary = result.verdicts.map(v => `${v.detector}=${v.state}`).join(' ');
      console.log(`[responder] ${new Date(now).toISOString()} ${summary} pages=${result.pagesSent}`);
    } catch (err) {
      // The loop outlives its own bugs. A responder that dies on one bad cycle
      // stops watching, and stops silently, which is the failure this whole
      // app is a response to. The sample ring is still persisted so the next
      // cycle does not lose its window.
      console.error(`[responder] cycle failed: ${(err as Error).message}`);
      try {
        saveState(config.stateDir, state);
      } catch {
        /* nothing useful to do; the next cycle will retry */
      }
    }

    if (once || stopping) break;
    await new Promise(resolve => setTimeout(resolve, config.intervalSeconds * 1_000));
    if (stopping) break;
  }

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
