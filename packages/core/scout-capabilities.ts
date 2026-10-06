/**
 * Quality Scout capability discovery — `discoverScoutCapabilities(input)`.
 *
 * Pure: a readiness report plus the workspace's `gitConfig.qualityScout`
 * declarations in, the probe-able surfaces out. Detection is NOT repeated here:
 * the readiness report (`computeReadiness`, recomputed per request) is the only
 * source of detected facts, and this module only projects it. Declarations add
 * what a repo cannot tell us — journeys, a safe test environment, fixtures and
 * write constraints.
 *
 * Status semantics carry over unchanged: a readiness `unknown` (truncated tree,
 * unread manifest, no repo) stays `unknown`, never `absent`. `usable` is the
 * separate safety verdict: available AND runnable under the declared
 * constraints. A probe that needs an unusable capability records `unsupported`.
 */

import type { WorkspaceQualityScoutConfig } from '@buildd/shared';
import type { ReadinessItem, ReadinessItemId, ReadinessReport } from './workspace-readiness';

export type ScoutCapabilityKind =
  | 'verification-command'
  | 'typecheck-command'
  | 'build-command'
  | 'ui-surface'
  | 'spec'
  | 'migrations'
  | 'release'
  | 'test-environment'
  | 'fixture-setup'
  | 'cli-journey'
  | 'api-journey';

export type ScoutCapabilityStatus = 'available' | 'absent' | 'unknown';

/** `paths`: repo path patterns the journey exercises; Scout prefers it for a change under them. */
export type ScoutJourney =
  | { name: string; kind: 'cli'; command: string; mutates: boolean; expect?: string; paths?: string[] }
  | { name: string; kind: 'api'; method: string; path: string; mutates: boolean; expect?: string; paths?: string[] };

export interface ScoutCapability {
  /** Stable: the kind, or `<kind>:<name>` for a journey. */
  id: string;
  kind: ScoutCapabilityKind;
  status: ScoutCapabilityStatus;
  source: 'readiness' | 'declared';
  readinessItemId?: ReadinessItemId;
  /** A command, a page source, a directory, a base URL — whatever the capability is. */
  value?: string;
  routes?: string[];
  journey?: ScoutJourney;
  /** Exercising it may write somewhere other than a throwaway checkout. */
  mutates: boolean;
  /** Where an API journey is sent. */
  target?: 'test-environment' | 'app-boot';
  /** `status === 'available'` and safe to run under the workspace's constraints. */
  usable: boolean;
  blockedReason?: string;
  evidence: string[];
}

export interface ResolvedScoutConstraints {
  allowWrites: 'never' | 'ephemeral-only';
  forbiddenPatterns: string[];
}

export interface ResolvedScoutExtension {
  verificationCommand?: string;
  testEnvironment?: { baseUrl?: string; ephemeral: boolean; description?: string };
  journeys: ScoutJourney[];
  uiRoutes: string[];
  fixtureSetup?: { command: string };
  constraints: ResolvedScoutConstraints;
}

export interface ScoutCapabilityProfile {
  capabilities: ScoutCapability[];
  /** From the UI surface: `unknown` when readiness could not tell. */
  hasUi: 'yes' | 'no' | 'unknown';
  /** The readiness tree was truncated: absences below are not proven. */
  truncated: boolean;
  constraints: ResolvedScoutConstraints;
  /** Declarations that were dropped as malformed or unsafe. */
  warnings: string[];
}

export interface ScoutCapabilityInput {
  readiness: ReadinessReport;
  /** `gitConfig.qualityScout`, unvalidated. */
  extension?: unknown;
}

/** Readiness item → Scout kind. Every other item is listed in IGNORED_READINESS_ITEMS. */
const PROJECTION: ReadonlyArray<[ReadinessItemId, ScoutCapabilityKind]> = [
  ['test-command', 'verification-command'],
  ['typecheck-command', 'typecheck-command'],
  ['build-command', 'build-command'],
  ['visual-qa-source', 'ui-surface'],
  ['spec-root', 'spec'],
  ['migrations-dir', 'migrations'],
  ['release-path', 'release'],
];

export const PROJECTED_READINESS_ITEMS: readonly ReadinessItemId[] = PROJECTION.map(([id]) => id);

/** Onboarding hygiene, not something a probe exercises. */
export const IGNORED_READINESS_ITEMS: readonly ReadinessItemId[] = [
  'agent-instructions',
  'spec-format',
  'env-manifest',
  'merge-policy',
];

/** Kinds that exist only by declaration: undeclared means absent, never unknown. */
const DECLARED_ONLY: ReadonlySet<ScoutCapabilityKind> = new Set([
  'test-environment',
  'fixture-setup',
  'cli-journey',
  'api-journey',
]);

const COMMAND_KINDS: ReadonlySet<ScoutCapabilityKind> = new Set(['verification-command', 'typecheck-command', 'build-command']);
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HTTP_METHODS = new Set([...READ_ONLY_METHODS, 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_JOURNEY_PATHS = 20;
/** A named script (`<tool> run <script>`) or make target: the command names a body it does not show. */
const OPAQUE_SCRIPT = /^(?:\S+\s+run|yarn|make)\s+\S/;

// ─── Extension resolution ────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonBlank = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function resolveJourney(raw: unknown, index: number, warnings: string[]): ScoutJourney | null {
  if (!isRecord(raw)) {
    warnings.push(`journeys[${index}] is not an object; ignored.`);
    return null;
  }
  const name = nonBlank(raw.name);
  if (!name) {
    warnings.push(`journeys[${index}] has no name; ignored.`);
    return null;
  }
  const expect = nonBlank(raw.expect);
  let paths: string[] = [];
  if (raw.paths !== undefined) {
    if (Array.isArray(raw.paths)) paths = [...new Set(raw.paths.map(nonBlank).filter((p): p is string => !!p))].slice(0, MAX_JOURNEY_PATHS);
    else warnings.push(`journey "${name}" has paths that are not an array; ignored.`);
  }
  const scope = paths.length > 0 ? { paths } : {};
  const declaredMutates = typeof raw.mutates === 'boolean' ? raw.mutates : undefined;
  if (raw.kind === 'cli') {
    const command = nonBlank(raw.command);
    if (!command) {
      warnings.push(`journey "${name}" (cli) has no command; ignored.`);
      return null;
    }
    // Effects of an arbitrary command are unknown until the owner says otherwise.
    return { name, kind: 'cli', command, mutates: declaredMutates ?? true, ...(expect ? { expect } : {}), ...scope };
  }
  if (raw.kind === 'api') {
    const path = nonBlank(raw.path);
    if (!path || !path.startsWith('/')) {
      warnings.push(
        `journey "${name}" (api) needs a path starting with "/" relative to the test environment; absolute URLs are refused so a probe cannot reach an undeclared host. Ignored.`,
      );
      return null;
    }
    const method = (nonBlank(raw.method) ?? 'GET').toUpperCase();
    if (!HTTP_METHODS.has(method)) {
      warnings.push(`journey "${name}" (api) has unsupported method "${method}"; ignored.`);
      return null;
    }
    // A write method is mutating whatever the declaration claims.
    const mutates = !READ_ONLY_METHODS.has(method) || declaredMutates === true;
    return { name, kind: 'api', method, path, mutates, ...(expect ? { expect } : {}), ...scope };
  }
  warnings.push(`journey "${name}" has unknown kind ${JSON.stringify(raw.kind)} (expected "cli" or "api"); ignored.`);
  return null;
}

/** Validate `gitConfig.qualityScout`. Never throws: malformed parts are dropped with a warning. */
export function resolveScoutExtension(raw: unknown): { config: ResolvedScoutExtension; warnings: string[] } {
  const warnings: string[] = [];
  const config: ResolvedScoutExtension = {
    journeys: [],
    uiRoutes: [],
    constraints: { allowWrites: 'ephemeral-only', forbiddenPatterns: [] },
  };
  if (raw === undefined || raw === null) return { config, warnings };
  if (!isRecord(raw)) {
    warnings.push('qualityScout is not an object; ignored.');
    return { config, warnings };
  }
  const c = raw as Record<string, unknown> & Partial<Record<keyof WorkspaceQualityScoutConfig, unknown>>;

  if (c.verificationCommand !== undefined) {
    const cmd = nonBlank(c.verificationCommand);
    if (cmd) config.verificationCommand = cmd;
    else warnings.push('verificationCommand is blank; ignored.');
  }

  if (c.testEnvironment !== undefined) {
    if (!isRecord(c.testEnvironment)) {
      warnings.push('testEnvironment is not an object; ignored.');
    } else {
      const env = c.testEnvironment;
      const baseUrl = nonBlank(env.baseUrl);
      const validUrl = baseUrl !== undefined && /^https?:\/\/[^/\s]+/i.test(baseUrl);
      if (baseUrl !== undefined && !validUrl) warnings.push(`testEnvironment.baseUrl "${baseUrl}" is not an http(s) URL; ignored.`);
      const description = nonBlank(env.description);
      config.testEnvironment = {
        ...(validUrl ? { baseUrl: baseUrl.replace(/\/+$/, '') } : {}),
        ephemeral: env.ephemeral === true,
        ...(description ? { description } : {}),
      };
    }
  }

  if (c.uiRoutes !== undefined) {
    const routes = Array.isArray(c.uiRoutes) ? c.uiRoutes : [];
    if (!Array.isArray(c.uiRoutes)) warnings.push('uiRoutes is not an array; ignored.');
    for (const r of routes) {
      if (typeof r === 'string' && r.startsWith('/')) {
        if (!config.uiRoutes.includes(r)) config.uiRoutes.push(r);
      } else {
        warnings.push(`uiRoutes entry ${JSON.stringify(r)} must start with "/"; ignored.`);
      }
    }
  }

  if (c.journeys !== undefined) {
    const list = Array.isArray(c.journeys) ? c.journeys : [];
    if (!Array.isArray(c.journeys)) warnings.push('journeys is not an array; ignored.');
    const seen = new Set<string>();
    list.forEach((j, i) => {
      const resolved = resolveJourney(j, i, warnings);
      if (!resolved) return;
      if (seen.has(resolved.name)) {
        warnings.push(`journey "${resolved.name}" is declared twice; the later one is ignored.`);
        return;
      }
      seen.add(resolved.name);
      config.journeys.push(resolved);
    });
  }

  if (c.fixtureSetup !== undefined) {
    const cmd = isRecord(c.fixtureSetup) ? nonBlank(c.fixtureSetup.command) : undefined;
    if (cmd) config.fixtureSetup = { command: cmd };
    else warnings.push('fixtureSetup needs a non-blank command; ignored.');
  }

  if (c.constraints !== undefined) {
    if (!isRecord(c.constraints)) {
      warnings.push('constraints is not an object; ignored.');
    } else {
      const { allowWrites, forbiddenPatterns } = c.constraints;
      if (allowWrites === 'never' || allowWrites === 'ephemeral-only') config.constraints.allowWrites = allowWrites;
      else if (allowWrites !== undefined) {
        warnings.push(`constraints.allowWrites ${JSON.stringify(allowWrites)} is not "never" or "ephemeral-only"; using "ephemeral-only".`);
      }
      if (forbiddenPatterns !== undefined) {
        for (const p of Array.isArray(forbiddenPatterns) ? forbiddenPatterns : [forbiddenPatterns]) {
          const pattern = nonBlank(p);
          if (pattern) config.constraints.forbiddenPatterns.push(pattern);
          else warnings.push(`constraints.forbiddenPatterns entry ${JSON.stringify(p)} is not a non-blank string; ignored.`);
        }
      }
    }
  }

  return { config, warnings };
}

// ─── Projection ──────────────────────────────────────────────────────────────

const STATUS: Record<ReadinessItem['status'], ScoutCapabilityStatus> = {
  detected: 'available',
  missing: 'absent',
  unknown: 'unknown',
};

function readinessEvidence(item: ReadinessItem): string[] {
  const lines = item.evidence.map((e) => (e.paths?.length ? `${e.note} (${e.paths.join(', ')})` : e.note));
  return item.waived ? [`Waived by the owner: ${item.waived.reason}`, ...lines] : lines;
}

function project(item: ReadinessItem, kind: ScoutCapabilityKind): ScoutCapability {
  return {
    id: kind,
    kind,
    // A waiver is the owner saying "not for this repo".
    status: item.waived ? 'absent' : STATUS[item.status],
    source: 'readiness',
    readinessItemId: item.id,
    ...(item.value !== undefined ? { value: item.value } : {}),
    mutates: false,
    usable: false,
    evidence: readinessEvidence(item),
  };
}

/** Readiness evaluated nothing for this item (an older report, or a detector removed). */
function notReported(kind: ScoutCapabilityKind, id: ReadinessItemId): ScoutCapability {
  return {
    id: kind,
    kind,
    status: 'unknown',
    source: 'readiness',
    readinessItemId: id,
    mutates: false,
    usable: false,
    evidence: [`The readiness report has no "${id}" item.`],
  };
}

function commandOf(c: ScoutCapability): string | undefined {
  if (c.journey?.kind === 'cli') return c.journey.command;
  if (COMMAND_KINDS.has(c.kind) || c.kind === 'fixture-setup') return c.value;
  return undefined;
}

/** Decide `usable` / `blockedReason` for one capability under the constraints. */
function judge(c: ScoutCapability, ext: ResolvedScoutExtension): ScoutCapability {
  const block = (blockedReason: string): ScoutCapability => ({ ...c, usable: false, blockedReason });
  if (c.status !== 'available') {
    return block(c.status === 'unknown' ? 'Readiness could not determine this capability.' : 'Not present in this workspace.');
  }

  const command = commandOf(c);
  const hit = command ? ext.constraints.forbiddenPatterns.find((p) => command.includes(p)) : undefined;
  if (hit) return block(`Command contains the forbidden pattern "${hit}".`);

  if (c.mutates) {
    if (ext.constraints.allowWrites === 'never') return block('Mutating, and the workspace allows no writes (allowWrites: never).');
    if (!ext.testEnvironment?.ephemeral) return block('Mutating, and no ephemeral test environment is declared.');
  }

  if (c.journey?.kind === 'api' && !c.target) return block('No test environment base URL and no bootable app to send it to.');

  return { ...c, usable: true };
}

export function discoverScoutCapabilities(input: ScoutCapabilityInput): ScoutCapabilityProfile {
  const { config: ext, warnings } = resolveScoutExtension(input.extension);
  const items = new Map(input.readiness.items.map((i) => [i.id, i]));

  const caps: ScoutCapability[] = PROJECTION.map(([id, kind]) => {
    const item = items.get(id);
    return item ? project(item, kind) : notReported(kind, id);
  });
  const byKind = (k: ScoutCapabilityKind) => caps.find((c) => c.kind === k) as ScoutCapability;

  const verify = byKind('verification-command');
  if (ext.verificationCommand) {
    Object.assign(verify, {
      status: 'available',
      source: 'declared',
      value: ext.verificationCommand,
      evidence: [
        'Declared in qualityScout.verificationCommand.',
        ...(verify.value ? [`Overrides the detected \`${verify.value}\`.`] : []),
        ...verify.evidence.map((e) => `Readiness: ${e}`),
      ],
    } satisfies Partial<ScoutCapability>);
  }

  const build = byKind('build-command');
  if (build.value && OPAQUE_SCRIPT.test(build.value)) {
    // The command screen sees `pnpm run build`, not the script body, and a
    // build script commonly migrates a database or regenerates code first.
    build.mutates = true;
    build.evidence = [...build.evidence, `\`${build.value}\` runs a script Scout cannot see into; treated as mutating.`];
  }

  const ui = byKind('ui-surface');
  if (ext.uiRoutes.length > 0) {
    ui.routes = [...ext.uiRoutes];
    if (ui.status === 'absent') {
      // The owner says there is UI; readiness found no way to show it. Neither proves the other wrong.
      ui.status = 'unknown';
      ui.evidence = [...ui.evidence, 'UI routes are declared, but no page source was detected to render them.'];
    }
  }

  if (ext.testEnvironment) {
    const env = ext.testEnvironment;
    caps.push({
      id: 'test-environment',
      kind: 'test-environment',
      status: 'available',
      source: 'declared',
      ...(env.baseUrl ? { value: env.baseUrl } : {}),
      mutates: false,
      usable: false,
      evidence: [
        `Declared ${env.ephemeral ? 'ephemeral (writes allowed)' : 'persistent (read-only)'} test environment${env.description ? `: ${env.description}` : ''}.`,
      ],
    });
  }

  if (ext.fixtureSetup) {
    caps.push({
      id: 'fixture-setup',
      kind: 'fixture-setup',
      status: 'available',
      source: 'declared',
      value: ext.fixtureSetup.command,
      mutates: true,
      usable: false,
      evidence: ['Declared in qualityScout.fixtureSetup.'],
    });
  }

  const appBoots = ui.status === 'available' && ui.source === 'readiness';
  for (const journey of ext.journeys) {
    const kind: ScoutCapabilityKind = journey.kind === 'cli' ? 'cli-journey' : 'api-journey';
    const target =
      journey.kind === 'api'
        ? ext.testEnvironment?.baseUrl
          ? ('test-environment' as const)
          : appBoots && !journey.mutates
            ? ('app-boot' as const)
            : undefined
        : undefined;
    caps.push({
      id: `${kind}:${journey.name}`,
      kind,
      status: 'available',
      source: 'declared',
      journey,
      mutates: journey.mutates,
      ...(target ? { target } : {}),
      usable: false,
      evidence: [`Declared journey "${journey.name}".`],
    });
  }

  const capabilities = caps.map((c) => judge(c, ext));
  const finalUi = capabilities.find((c) => c.kind === 'ui-surface') as ScoutCapability;
  return {
    capabilities,
    hasUi: finalUi.status === 'available' ? 'yes' : finalUi.status === 'absent' ? 'no' : 'unknown',
    truncated: input.readiness.truncated,
    constraints: ext.constraints,
    warnings,
  };
}

/**
 * The best status for a kind: `available` if any capability of it is,
 * else `unknown` if any is, else `absent`. An undeclared declaration-only
 * kind is `absent` — nothing could have detected it.
 */
export function scoutCapabilityStatus(profile: ScoutCapabilityProfile, kind: ScoutCapabilityKind): ScoutCapabilityStatus {
  const of = profile.capabilities.filter((c) => c.kind === kind);
  if (of.some((c) => c.status === 'available')) return 'available';
  if (of.some((c) => c.status === 'unknown')) return 'unknown';
  if (of.length === 0 && !DECLARED_ONLY.has(kind)) return 'unknown';
  return 'absent';
}
