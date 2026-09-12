#!/usr/bin/env bun
/**
 * Property check: the pinned codebase-memory-mcp build still steers agents away
 * from grep in its OWN tool descriptions.
 *
 * WHY THIS EXISTS
 * ---------------
 * buildd's graph steering has two independent layers. The first is ours:
 * `buildCbmGuidanceBody` (apps/runner/src/cbm-enforcement.ts) injects an ordered,
 * procedural block into the Claude system prompt / Codex AGENTS.md. The second is
 * the vendor's: through 0.10.8 the MCP `tools/list` descriptions for the graph
 * tools themselves say to use them INSTEAD OF grep/glob. That second layer is
 * reinforcement at the exact moment of tool selection, which is where routing
 * decisions are actually made, and it is the only steering a session gets in any
 * path where our prompt block is absent (CBM mounted via a role connector or a
 * project `.mcp.json` — CBM-12 suppresses our injection, not the mount).
 *
 * An upstream token-reduction pass stripped that text from the descriptions as
 * collateral damage; it is gone on upstream main. A routine `CBM_VERSION` bump
 * would therefore silently delete half of buildd's grep steering with ZERO
 * visible diff on our side: no test fails, the binary still works, and the only
 * symptom is a slow drift back to Read/Grep/Glob that CBM-21 would eventually
 * notice as "enforced but unused" — after ten tasks have already run that way.
 *
 * WHY A PROPERTY CHECK AND NOT A VERSION CEILING
 * ----------------------------------------------
 * Pinning "never go past 0.10.8" would freeze the fleet on an old build to
 * protect one sentence, and would age into a lie the moment upstream restores
 * the text. What we actually care about is the PROPERTY, so that is what is
 * asserted: bump freely, and if the new build still carries grep steering this
 * passes. If it does not, this fails and names what was lost, and the decision
 * (accept the bump and strengthen our own block, or hold) becomes a deliberate
 * one made with the fact in hand instead of a discovery made months later.
 *
 * THE MATCHING RULE, AND ITS TOLERANCE
 * ------------------------------------
 * Exact-matching the vendor's sentence would break on harmless rewording, and a
 * gate that fails for cosmetic reasons gets deleted. So each required tool must
 * satisfy two coarse signals over its description, both case-insensitive and
 * whitespace-insensitive:
 *
 *   1. MENTIONS_GREP   — the description names a text-search tool at all
 *                        (grep / glob / ripgrep / rg).
 *   2. DISPLACES_GREP  — it names one in a *displacement* construction: a phrase
 *                        meaning "use this rather than that" (instead of, in
 *                        place of, rather than, prefer X over, don't use, avoid,
 *                        before reaching for …) within a short window of the
 *                        grep-family word.
 *
 * Tolerated: any rewording that keeps a displacement phrase near a grep-family
 * word, reordering, punctuation changes, case changes, line wrapping, changes to
 * the trailing list of use cases ("definitions, implementations, relationships"),
 * and any amount of surrounding new text.
 * NOT tolerated: dropping the grep-family word, or demoting it to a neutral
 * mention. Signal 1 alone is deliberately not enough — `search_code` mentions
 * grep purely as an implementation detail ("finds text patterns via grep"), which
 * is not steering, and the whole failure mode being guarded is steering text
 * decaying into description text.
 *
 * FAIL-CLOSED
 * -----------
 * Every unknown is a failure: missing binary, spawn error, handshake timeout,
 * JSON-RPC error, empty tools list, required tool absent, empty description. A
 * check that reads "no evidence of steering" as "steering present" is exactly the
 * green-over-empty-set failure this repo has shipped repeatedly, so there is no
 * path through this file that reports success without having read a non-empty
 * description for every required tool.
 *
 * Run: bun scripts/verify-cbm-grep-steering.ts
 *      CBM_BINARY=/path/to/codebase-memory-mcp bun scripts/verify-cbm-grep-steering.ts
 * CI:  .github/workflows/worker-image.yml (alongside scripts/verify-cbm-pin.sh)
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Tool shape we care about out of an MCP `tools/list` result. */
export interface AdvertisedTool {
  name?: unknown;
  description?: unknown;
}

export interface SteeringRequirement {
  /** MCP tool name as advertised by the server. */
  tool: string;
  /** What the steering is protecting, for the failure message. */
  routes: string;
}

/**
 * The tools whose descriptions must carry grep steering.
 *
 * Only the two navigation entry points. `get_code_snippet` and `search_code` are
 * deliberately excluded: the first is a read tool (its description steers toward
 * `search_graph` first, not away from grep) and the second IS a grep wrapper, so
 * requiring displacement language there would be nonsense.
 */
export const CBM_STEERING_REQUIREMENTS: readonly SteeringRequirement[] = [
  { tool: 'search_graph', routes: 'finding definitions, implementations and relationships' },
  { tool: 'trace_path', routes: 'callers, dependencies, impact analysis and data flow' },
];

/** Text-search vocabulary the steering may displace. */
const GREP_FAMILY = String.raw`(?:grep|glob|ripgrep|rg\b)`;

/**
 * Phrases that mean "use this tool rather than that one", each with how much
 * filler may sit between the cue and the grep-family word.
 *
 * A small set of independent cues rather than one regex: any single cue
 * surviving an upstream rewording keeps the gate green. `window` is per-cue
 * because the cues differ in how specific they are — "instead of" is only ever
 * displacement, so it can reach across "instead of a filesystem-wide grep",
 * while "over" and "avoid" are common enough in ordinary prose that they are
 * only trusted immediately adjacent to the grep word.
 *
 * Deliberately NOT a cue: a bare "prefer". CBM's own `get_code_snippet` and
 * `index_status` descriptions say to "prefer grep" inside partially-indexed
 * ranges, which is steering *toward* grep; a cue that matched it would let a
 * stripped build pass on the strength of a sentence with the opposite meaning.
 */
const DISPLACEMENT_CUES: readonly { phrase: string; window: number }[] = [
  { phrase: 'instead of', window: 40 },
  { phrase: 'in place of', window: 40 },
  { phrase: 'rather than', window: 40 },
  { phrase: 'in preference to', window: 40 },
  { phrase: 'do not use', window: 30 },
  { phrase: "don't use", window: 30 },
  { phrase: 'do not reach for', window: 30 },
  { phrase: 'before using', window: 20 },
  { phrase: 'before reaching for', window: 20 },
  { phrase: 'avoid', window: 15 },
  { phrase: 'over', window: 10 },
];

/** Lowercase, collapse whitespace — descriptions are wrapped and re-wrapped upstream. */
export function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface SteeringSignals {
  mentionsGrep: boolean;
  displacesGrep: boolean;
  /** The cue that matched, for the pass log. */
  matchedCue?: string;
}

/** Apply the matching rule to one description. */
export function findSteeringSignals(description: string): SteeringSignals {
  const text = normalizeDescription(description);
  const mentionsGrep = new RegExp(GREP_FAMILY).test(text);
  for (const cue of DISPLACEMENT_CUES) {
    const cueSource = cue.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // [\s\S] rather than `.`: a description carrying a CR would otherwise split
    // the window in a way `.` cannot cross (see js-dot-star-dollar note).
    const pattern = new RegExp(`${cueSource}[\\s\\S]{0,${cue.window}}?${GREP_FAMILY}`);
    if (pattern.test(text)) return { mentionsGrep, displacesGrep: true, matchedCue: cue.phrase };
  }
  return { mentionsGrep, displacesGrep: false };
}

export interface SteeringEvaluation {
  ok: boolean;
  /** One line per requirement, for the log. */
  checked: { tool: string; ok: boolean; detail: string }[];
  /** Human-readable reasons, empty iff ok. */
  failures: string[];
}

/**
 * Evaluate an advertised tool list against every requirement.
 *
 * Pure — the handshake is the caller's job — so the failure modes are unit
 * testable without a binary.
 */
export function evaluateCbmSteering(tools: readonly AdvertisedTool[]): SteeringEvaluation {
  const failures: string[] = [];
  const checked: SteeringEvaluation['checked'] = [];

  // Fail closed on an empty surface: a handshake that returned nothing, a server
  // that advertised nothing, or a payload we failed to parse all land here, and
  // none of them is evidence that the steering survived.
  if (tools.length === 0) {
    failures.push(
      'tools/list returned NO tools. This is a failure, not a pass: an empty tool ' +
        'surface is indistinguishable from a broken handshake, and neither proves ' +
        'the grep steering is present.',
    );
    return { ok: false, checked, failures };
  }

  for (const requirement of CBM_STEERING_REQUIREMENTS) {
    const found = tools.find(tool => tool.name === requirement.tool);
    if (!found) {
      failures.push(
        `tool '${requirement.tool}' is not advertised by this build (saw: ` +
          `${tools.map(t => String(t.name)).join(', ')}). Either the tool was renamed ` +
          `or the handshake reached the wrong server; both must be looked at by hand.`,
      );
      checked.push({ tool: requirement.tool, ok: false, detail: 'not advertised' });
      continue;
    }
    const description = typeof found.description === 'string' ? found.description : '';
    if (description.trim() === '') {
      failures.push(
        `tool '${requirement.tool}' advertises an empty description, so it carries no ` +
          `steering of any kind.`,
      );
      checked.push({ tool: requirement.tool, ok: false, detail: 'empty description' });
      continue;
    }

    const signals = findSteeringSignals(description);
    if (signals.displacesGrep) {
      checked.push({
        tool: requirement.tool,
        ok: true,
        detail: `displacement cue '${signals.matchedCue}' near a grep-family word`,
      });
      continue;
    }

    const lost = signals.mentionsGrep
      ? `mentions grep/glob but no longer as something to use it INSTEAD OF — the ` +
        `mention has decayed from steering into description`
      : `no longer mentions grep or glob at all`;
    failures.push(
      `tool '${requirement.tool}' ${lost}.\n` +
        `      WHAT THIS COSTS: that sentence is the vendor-side half of buildd's grep ` +
        `steering — a second, independent reinforcement delivered at tool-selection ` +
        `time, and the ONLY steering a session gets when CBM is mounted by a role ` +
        `connector or a project .mcp.json (CBM-12 suppresses our prompt block, not the ` +
        `mount). Losing it silently degrades routing for ${requirement.routes} back ` +
        `toward Read/Grep/Glob, and the only downstream symptom is CBM-21 firing after ` +
        `ten tasks have already run that way.\n` +
        `      ADVERTISED DESCRIPTION WAS: ${normalizeDescription(description).slice(0, 300)}`,
    );
    checked.push({ tool: requirement.tool, ok: false, detail: lost });
  }

  return { ok: failures.length === 0, checked, failures };
}

/** Render the verdict as the block CI prints. */
export function formatSteeringReport(evaluation: SteeringEvaluation): string {
  const lines = evaluation.checked.map(
    entry => `  ${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.tool}  —  ${entry.detail}`,
  );
  if (evaluation.ok) {
    lines.push('vendor grep steering intact on every required graph tool');
    return lines.join('\n');
  }
  lines.push('', 'FAIL: the pinned CBM build has lost vendor-side grep steering.', '');
  for (const failure of evaluation.failures) lines.push(`  - ${failure}`);
  lines.push(
    '',
    'This is NOT a reason to refuse every bump. It is a decision point: either keep',
    'the older build, or take the new one and compensate in buildCbmGuidanceBody',
    '(apps/runner/src/cbm-enforcement.ts) — and in that case update this check so it',
    'asserts whatever the new build actually guarantees. Do not delete the check.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Runtime: the MCP handshake. Everything below needs a real binary.
// ---------------------------------------------------------------------------

/** The pinned version, read from the Dockerfile so nothing here hardcodes one. */
export function pinnedCbmVersion(dockerfile: string): string | null {
  return dockerfile.match(/^ARG CBM_VERSION=(\S+)/m)?.[1] ?? null;
}

const REPO_ROOT = join(import.meta.dir, '..');

/**
 * Where the binary might be.
 *
 * CI hands us an explicit path via CBM_BINARY (the workflow downloads the pinned
 * release). The other two are developer convenience: the worker image path, and
 * the per-version dir `install.sh` uses on a mac.
 */
async function resolveBinary(): Promise<string> {
  const explicit = process.env.CBM_BINARY;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`CBM_BINARY=${explicit} does not exist`);
    }
    return explicit;
  }

  const candidates = ['/opt/buildd/bin/codebase-memory-mcp'];
  // Bun.file, not readFileSync: any caller that mocks 'fs' would otherwise get a stub.
  const dockerfile = await Bun.file(join(REPO_ROOT, 'docker/worker/Dockerfile')).text();
  const version = pinnedCbmVersion(dockerfile);
  if (version) candidates.push(join(homedir(), '.buildd/cbm', version, 'codebase-memory-mcp'));

  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) {
    throw new Error(
      `no codebase-memory-mcp binary found (looked at: ${candidates.join(', ')}).\n` +
        `This check needs the real binary — it asserts what the BUILD advertises, which ` +
        `no amount of reading our own source can answer. Set CBM_BINARY=<path>, or run ` +
        `apps/runner/install.sh to provision the pin.`,
    );
  }
  return found;
}

/** Overall handshake budget. Generous: 0.10.x pays a daemon cold start. */
const HANDSHAKE_TIMEOUT_MS = Number(process.env.CBM_STEERING_TIMEOUT_MS ?? 60_000);

/**
 * `tools/list` over stdio against a real binary.
 *
 * Two environment details are load-bearing and cost real time to rediscover:
 *   - CBM_RUNTIME_DIR must EXIST and not be world-writable, or the daemon exits
 *     with "secure daemon endpoint could not be created" (see ensureCbmRuntimeDir).
 *   - It must also be a SHORT path. The daemon binds a unix socket inside it and
 *     `sockaddr_un.sun_path` caps at ~104 bytes on darwin, so a nested temp dir
 *     fails with the same opaque message as a missing one. Hence /tmp directly.
 */
export async function listAdvertisedTools(binary: string): Promise<AdvertisedTool[]> {
  const runtimeDir = join('/tmp', `cbm-steering-${process.pid}-run`);
  const cacheDir = join('/tmp', `cbm-steering-${process.pid}-cache`);
  for (const dir of [runtimeDir, cacheDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const child = spawn(binary, ['mcp'], {
    env: {
      ...process.env,
      CBM_CACHE_DIR: cacheDir,
      CBM_RUNTIME_DIR: runtimeDir,
      CBM_ALLOWED_ROOT: cacheDir,
      CBM_AUTO_WATCH: 'false',
      CBM_MEM_BUDGET_MB: '1024',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

  return await new Promise<AdvertisedTool[]>((resolve, reject) => {
    let buffered = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `handshake did not complete within ${HANDSHAKE_TIMEOUT_MS}ms. Treated as a ` +
              `failure: an unanswered tools/list says nothing about the steering.` +
              (stderr ? `\nstderr: ${stderr.trim().slice(0, 600)}` : ''),
          ),
        ),
      );
    }, HANDSHAKE_TIMEOUT_MS);

    child.on('error', error => finish(() => reject(error)));
    child.on('exit', code =>
      finish(() =>
        reject(
          new Error(
            `binary exited (code ${code}) before answering tools/list.` +
              (stderr ? `\nstderr: ${stderr.trim().slice(0, 600)}` : ''),
          ),
        ),
      ),
    );
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    child.stdout.on('data', chunk => {
      buffered += String(chunk);
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, any>;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // Log noise on stdout is possible; a partial line is re-buffered above.
        }
        if (message.error) {
          finish(() => reject(new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`)));
          return;
        }
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          continue;
        }
        if (message.id === 2) {
          const tools = message.result?.tools;
          finish(() => resolve(Array.isArray(tools) ? tools : []));
          return;
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'buildd-cbm-steering-check', version: '1' },
      },
    });
  });
}

if (import.meta.main) {
  let tools: AdvertisedTool[];
  try {
    const binary = await resolveBinary();
    console.log(`probing ${binary}`);
    tools = await listAdvertisedTools(binary);
  } catch (error) {
    // Fail closed and loudly. Everything from "no binary" to "daemon refused" is
    // an unmeasured property, and an unmeasured property is not a satisfied one.
    console.error(`FAIL: could not read the advertised tool descriptions.\n  ${error}`);
    process.exit(1);
  }

  console.log(`advertised tools: ${tools.length}`);
  const evaluation = evaluateCbmSteering(tools);
  console.log(formatSteeringReport(evaluation));
  process.exit(evaluation.ok ? 0 : 1);
}
