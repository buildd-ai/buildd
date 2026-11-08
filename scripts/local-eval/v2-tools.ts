/**
 * Tool efficiency of controlled replay runs. The agent subprocess is Claude
 * Code with `--output-format stream-json`; its stdout is imported with the
 * released runner transcript importer and analysed by tea-v1, here, on the
 * evaluator's machine. Only the bounded aggregate and its provenance go into
 * `run.json` (packages/core/local-eval.ts `ReplayToolEfficiency`): no commands,
 * prompts, source, paths, claims or fingerprints.
 *
 * stream-json lines carry no timestamps, so timing is `unknown` and the
 * aggregate's timing is empty rather than invented. Finding kinds are heuristic
 * candidates, never a correctness or wasted-calls score: correctness stays with
 * the hidden verifier and review.
 *
 * `enrichRunDir` adds the block to a run recorded before this existed, from its
 * stored (redacted) `agent.stdout.txt`. It starts no model and changes nothing
 * else; a run that already has the block, a fixture run, or a run with no
 * stored stdout is left as it is.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayToolEfficiencyFromStream } from '../../apps/runner/src/tool-trace-report';
import { validateRunRecord, type ReplayToolEfficiency } from '../../packages/core/local-eval';
import { hasSecret, redactDeep } from '../../packages/core/local-eval-v2-ops';

/** The block for one run's agent stdout; null for a fixture (no model) or a stdout with no tool transcript. */
export function toolEfficiencyOfRun(harness: string, stdout: string): ReplayToolEfficiency | null {
  if (harness === 'fixture') return null;
  return replayToolEfficiencyFromStream(stdout);
}

/** Why a stored run.json must not be sent to the ingest route; null = send it. */
export function ingestRefusal(raw: string): string | null {
  if (hasSecret(raw)) return 'contains a secret-shaped string; run `redact` first. Not sent.';
  let rec: any;
  try { rec = JSON.parse(raw); } catch { return 'is not JSON. Not sent.'; }
  if (rec?.harness?.name === 'fixture') return 'a fixture run (no model) is not an observation. Not sent.';
  const errs = validateRunRecord(rec);
  return errs.length ? errs.join('; ') : null;
}

export interface EnrichResult { runDir: string; runId: string | null; action: 'enriched' | 'unchanged' | 'skipped'; reason: string }

export function enrichRunDir(runDir: string, apply: boolean): EnrichResult {
  const recPath = join(runDir, 'run.json');
  if (!existsSync(recPath)) return { runDir, runId: null, action: 'skipped', reason: 'no run.json' };
  const rec = JSON.parse(readFileSync(recPath, 'utf8'));
  const runId = typeof rec?.runId === 'string' ? rec.runId : null;
  const skip = (reason: string): EnrichResult => ({ runDir, runId, action: 'skipped', reason });
  if (rec?.harness?.name === 'fixture') return skip('fixture run (no model): not enriched, and ingest still refuses it');
  if (rec.toolEfficiency) return { runDir, runId, action: 'unchanged', reason: 'already carries tool efficiency' };
  const outPath = join(runDir, 'agent.stdout.txt');
  if (!existsSync(outPath)) return skip('no stored agent stdout: tool efficiency stays unknown');
  const te = toolEfficiencyOfRun(rec.harness?.name ?? '', readFileSync(outPath, 'utf8'));
  if (!te) return skip('stored stdout holds no tool transcript: tool efficiency stays unknown');
  const next = { ...rec, toolEfficiency: te };
  const errs = validateRunRecord(next);
  if (errs.length) return skip(`not enriched: ${errs.join('; ')}`);
  if (apply) writeFileSync(recPath, JSON.stringify(redactDeep(next), null, 2) + '\n');
  return { runDir, runId, action: 'enriched', reason: `${te.aggregate.calls} call(s), timing ${te.timing}${apply ? '' : ' (dry run)'}` };
}
