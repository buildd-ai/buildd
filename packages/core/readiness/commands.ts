/**
 * test / typecheck / build command detection.
 *
 * Candidates come from `ecosystem-detect` (lockfile + manifest scripts +
 * language conventions) and from Makefile targets; CI `run:` lines only
 * corroborate a candidate, they never introduce one.
 */

import type { DetectedEcosystem } from '../ecosystem-detect';
import { detector, type ReadinessContext } from './context';
import type { ReadinessEvidence, ReadinessItem } from './types';

type Kind = 'test' | 'typecheck' | 'build';

interface Candidate {
  command: string;
  /** The file that yields it (or the ecosystem's root manifest for a language convention). */
  path: string;
  origin: 'script' | 'convention' | 'makefile';
  ecosystem?: DetectedEcosystem;
}

const MAKE_TARGETS: Record<Kind, string[]> = {
  test: ['test', 'tests'],
  typecheck: ['typecheck', 'type-check', 'check-types', 'types'],
  build: ['build'],
};

const ROOT_MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Makefile'];
// A manifest in a subdirectory only: root-level detection cannot see into it.
const NESTED_MANIFEST = /^(?:.+\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/;
const VENDORED = /(?:^|\/)(?:node_modules|vendor|third_party|\.venv|venv)\//;
const NPM_PLACEHOLDER = /no test specified/i;
const CI_FILE = /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml)$/;

function rootManifestFor(e: DetectedEcosystem, ctx: ReadinessContext): string {
  const pick = (names: string[]) => names.find((n) => ctx.hasFile(n)) ?? names[0];
  switch (e.ecosystem) {
    case 'node':
      return 'package.json';
    case 'python':
      return pick(['pyproject.toml', 'pytest.ini', 'mypy.ini', 'pyrightconfig.json', 'requirements.txt']);
    case 'rust':
      return 'Cargo.toml';
    case 'go':
      return 'go.mod';
  }
}

function nodeScripts(ctx: ReadinessContext): Record<string, unknown> {
  try {
    const parsed = JSON.parse(ctx.manifests['package.json'] ?? '{}');
    return parsed && typeof parsed.scripts === 'object' && parsed.scripts ? parsed.scripts : {};
  } catch {
    return {};
  }
}

function makeTargets(ctx: ReadinessContext): Set<string> {
  const text = ctx.manifests['Makefile'];
  const targets = new Set<string>();
  if (!text) return targets;
  for (const m of text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) targets.add(m[1]);
  return targets;
}

function collect(ctx: ReadinessContext, kind: Kind): Candidate[] {
  const out: Candidate[] = [];
  const scripts = nodeScripts(ctx);
  for (const e of ctx.ecosystems) {
    for (const c of e[kind]) {
      if (e.ecosystem === 'node') {
        const script = c.command.split(' ').pop() ?? '';
        if (typeof scripts[script] === 'string' && NPM_PLACEHOLDER.test(scripts[script] as string)) continue;
      }
      out.push({
        command: c.command,
        path: rootManifestFor(e, ctx),
        origin: c.source === 'convention' ? 'convention' : 'script',
        ecosystem: e,
      });
    }
  }
  if (kind === 'build') {
    // ecosystem-detect has no Python build command; a `[build-system]` table is the signal for one.
    const py = ctx.ecosystems.find((e) => e.ecosystem === 'python');
    if (py && /^\s*\[build-system\]/m.test(ctx.manifests['pyproject.toml'] ?? '')) {
      const command = py.packageManager === 'pip' ? 'python -m build' : `${py.packageManager} build`;
      out.push({ command, path: 'pyproject.toml', origin: 'script', ecosystem: py });
    }
  }
  const targets = makeTargets(ctx);
  for (const t of MAKE_TARGETS[kind]) {
    if (targets.has(t)) out.push({ command: `make ${t}`, path: 'Makefile', origin: 'makefile' });
  }
  return out;
}

function ciLines(ctx: ReadinessContext): { path: string; lines: string[] }[] {
  return Object.keys(ctx.manifests)
    .filter((p) => CI_FILE.test(p))
    .map((path) => ({
      path,
      lines: ctx.manifests[path]
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.replace(/^-\s*/, '').replace(/^run:\s*/, '')),
    }));
}

function ciMentions(ctx: ReadinessContext, command: string): string | null {
  const variants = [command, command.replace(/^([\w-]+) run /, '$1 '), command.replace(/^(?:uv|poetry) run /, '')];
  for (const ci of ciLines(ctx)) {
    if (ci.lines.some((l) => variants.some((v) => l.includes(v)))) return ci.path;
  }
  return null;
}

/** Manifests that exist but were not supplied: a command could be hiding in them. */
function unreadableManifests(ctx: ReadinessContext): string[] {
  return ROOT_MANIFESTS.filter((m) => ctx.unreadable(m));
}

function nestedManifests(ctx: ReadinessContext): string[] {
  return ctx.files.filter((f) => NESTED_MANIFEST.test(f) && !VENDORED.test(f));
}

const commandDetector = (
  id: 'test-command' | 'typecheck-command' | 'build-command',
  kind: Kind,
  label: string,
  importance: ReadinessItem['importance'],
) =>
  detector({ id, label, importance }, (ctx) => {
    const candidates = collect(ctx, kind);
    if (candidates.length > 0) {
      const evidence: ReadinessEvidence[] = candidates.map((c) => {
        const ci = ciMentions(ctx, c.command);
        const how =
          c.origin === 'convention'
            ? `the ${c.ecosystem?.ecosystem} toolchain's standard command (no script to read)`
            : c.origin === 'makefile'
              ? 'a Makefile target'
              : 'a manifest script or tool config';
        return {
          kind: 'manifest',
          paths: ci ? [c.path, ci] : [c.path],
          note: `\`${c.command}\` from ${how}. ${
            ci ? 'Also run by CI.' : 'Not corroborated by a CI run line (lower confidence).'
          }`,
        };
      });
      return { status: 'detected', value: candidates[0].command, evidence, fix: null };
    }

    const unreadable = unreadableManifests(ctx);
    if (unreadable.length > 0) {
      return {
        status: 'unknown',
        evidence: [
          { kind: 'signal', paths: unreadable, note: 'Manifest present but not read (too large or over the read cap).' },
        ],
        fix: null,
      };
    }

    const nested = ctx.ecosystems.length === 0 ? nestedManifests(ctx) : [];
    if (nested.length > 0) {
      return {
        status: 'unknown',
        evidence: [
          {
            kind: 'path',
            paths: nested.slice(0, 5),
            note: 'Toolchain manifests exist only in subdirectories; detection reads the repo root only.',
          },
        ],
        fix: null,
      };
    }

    const status = ctx.absentStatus();
    const toolchain =
      ctx.ecosystems.length > 0
        ? `No ${kind} command in the ${ctx.ecosystems.map((e) => e.ecosystem).join('/')} manifests.`
        : 'No recognised toolchain manifest at the repo root.';
    return {
      status,
      evidence: [status === 'unknown' ? ctx.absentNote(`A ${kind} command`) : { kind: 'absent', note: toolchain }],
      fix:
        status === 'unknown'
          ? null
          : {
              kind: 'owner-decision',
              summary:
                kind === 'test'
                  ? 'Name the command that runs the tests; it is recorded in the instructions file.'
                  : `Name the ${kind} command, or waive this item if the project has no ${kind} step.`,
            },
    };
  });

export const detectTestCommand = commandDetector('test-command', 'test', 'Test command', 'core');
export const detectTypecheckCommand = commandDetector('typecheck-command', 'typecheck', 'Typecheck command', 'recommended');
export const detectBuildCommand = commandDetector('build-command', 'build', 'Build command', 'recommended');

/** The command a visual-QA sandbox would run to serve the app, from manifest scripts / Makefile. */
export function detectStartCommand(ctx: ReadinessContext): { command: string; path: string } | null {
  const scripts = nodeScripts(ctx);
  const node = ctx.ecosystems.find((e) => e.ecosystem === 'node');
  if (node) {
    const script = ['dev', 'start', 'serve'].find((s) => typeof scripts[s] === 'string');
    if (script) return { command: `${node.packageManager} run ${script}`, path: 'package.json' };
  }
  const targets = makeTargets(ctx);
  const target = ['dev', 'serve', 'run', 'start'].find((t) => targets.has(t));
  return target ? { command: `make ${target}`, path: 'Makefile' } : null;
}
