/**
 * The cloud runner as one buildd release ships it, and the Cloudflare API
 * requests that deploy it without wrangler or Docker.
 *
 * buildd CI (publish-runner-image.yml, scripts/build-release-bundle.ts)
 * attaches one asset per release tag, `cloud-runner-<tag>.json`: the Worker
 * bundle `wrangler deploy --dry-run` produces, the wrangler config it was built
 * from, and the runner image pinned by digest. buildd's server deploys from
 * that asset (Settings → Runners → Cloudflare → Deploy), so a team needs no
 * checkout, no Docker and no token on a machine.
 *
 * Pure and runtime-free like deploy-plan.ts: the request builders mirror what
 * wrangler 4.151.1 sends (wrangler-dist/cli.js: createWorkerUploadForm,
 * getMigrationsToUpload, containerConfigToCreateRequest, apply), and the
 * caller does the I/O. Design: knowledge-base: buildd/design/cloud-runner-one-click-deploy.md.
 */
import { SNAPSHOT_BUCKET } from './deploy-plan';

export const RELEASE_BUNDLE_SCHEMA = 1;
export const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;

/** The release asset's file name. */
export function releaseBundleAssetName(tag: string): string {
  return `cloud-runner-${tag}.json`;
}

/**
 * Images Cloudflare can pull under the `default` scheduling policy without
 * registry credentials: a public Docker Hub image, pinned by digest so a
 * release always deploys the runner it shipped. GHCR is not on Cloudflare's
 * list of registries (containers/platform-details/image-management).
 */
export const PULLABLE_IMAGE_RE = /^docker\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;

export interface WranglerContainer {
  class_name: string;
  image: string;
  image_build_context?: string;
  instance_type: string;
  max_instances: number;
  rollout_active_grace_period?: number;
}

/** The parts of wrangler.jsonc a deploy reads. */
export interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  browser?: { binding: string };
  observability?: { enabled?: boolean };
  version_metadata?: { binding: string };
  limits?: { cpu_ms?: number };
  containers: WranglerContainer[];
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{ tag: string } & Record<string, unknown>>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  vars?: Record<string, string>;
}

/** wrangler.jsonc text (whole-line `//` comments allowed) as an object. */
export function parseWranglerConfig(text: string): WranglerConfig {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as WranglerConfig;
}

/**
 * The config CI bundles a release from: every container class runs `image`
 * instead of building the Dockerfile, so `wrangler deploy --dry-run` needs no
 * Docker and the bundle names the image it ships with.
 */
export function releaseConfig(text: string, image: string): WranglerConfig {
  const cfg = parseWranglerConfig(text);
  return {
    ...cfg,
    containers: cfg.containers.map(({ image_build_context: _ctx, ...c }) => ({ ...c, image })),
  };
}

export interface ReleaseModule {
  name: string;
  content: string;
}

export interface ReleaseBundle {
  schema: typeof RELEASE_BUNDLE_SCHEMA;
  tag: string;
  /** Digest-pinned image Cloudflare can pull, or null when this release published none. */
  image: string | null;
  config: WranglerConfig;
  mainModule: string;
  modules: ReleaseModule[];
}

const MODULE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const CLASS_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Validate a fetched asset. Everything the deploy reads is checked here, once. */
export function parseReleaseBundle(raw: unknown, expectedTag: string): { ok: true; bundle: ReleaseBundle } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'the release bundle is not an object' };
  const b = raw as Record<string, unknown>;
  if (b.schema !== RELEASE_BUNDLE_SCHEMA) return { ok: false, error: `the release bundle has schema ${String(b.schema)}, expected ${RELEASE_BUNDLE_SCHEMA}` };
  if (b.tag !== expectedTag) return { ok: false, error: `the release bundle is for ${String(b.tag)}, not ${expectedTag}` };
  if (b.image !== null && (typeof b.image !== 'string' || !PULLABLE_IMAGE_RE.test(b.image))) {
    return { ok: false, error: 'the release bundle\'s image is not a digest-pinned Docker Hub image' };
  }
  if (!Array.isArray(b.modules) || b.modules.length === 0) return { ok: false, error: 'the release bundle has no modules' };
  const modules: ReleaseModule[] = [];
  for (const m of b.modules as unknown[]) {
    const mod = m as Record<string, unknown> | null;
    if (!mod || typeof mod.name !== 'string' || !MODULE_NAME_RE.test(mod.name) || typeof mod.content !== 'string') {
      return { ok: false, error: 'a release bundle module has no plain name or content' };
    }
    modules.push({ name: mod.name, content: mod.content });
  }
  if (typeof b.mainModule !== 'string' || !modules.some(m => m.name === b.mainModule)) {
    return { ok: false, error: 'the release bundle\'s main module is missing' };
  }
  const cfg = b.config as WranglerConfig | null;
  if (!cfg || typeof cfg !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(cfg.compatibility_date))) {
    return { ok: false, error: 'the release bundle has no wrangler config' };
  }
  const doClasses = new Set((cfg.durable_objects?.bindings ?? []).map(d => d.class_name));
  if (!Array.isArray(cfg.containers) || cfg.containers.length === 0) return { ok: false, error: 'the release bundle declares no containers' };
  for (const c of cfg.containers) {
    if (!CLASS_RE.test(String(c.class_name)) || !doClasses.has(c.class_name)) {
      return { ok: false, error: `container class ${String(c.class_name)} has no Durable Object binding` };
    }
    if (typeof c.instance_type !== 'string' || typeof c.max_instances !== 'number') {
      return { ok: false, error: `container class ${c.class_name} has no instance type or ceiling` };
    }
  }
  if (!Array.isArray(cfg.migrations) || cfg.migrations.some(m => typeof m?.tag !== 'string')) {
    return { ok: false, error: 'the release bundle\'s migrations have no tags' };
  }
  return { ok: true, bundle: { schema: RELEASE_BUNDLE_SCHEMA, tag: expectedTag, image: b.image as string | null, config: cfg, mainModule: b.mainModule, modules } };
}

/**
 * The config for a Worker named `script`: the same renames deploy.ts --name
 * makes (deploy-plan.ts renderWranglerConfig), so a deployment under another
 * name gets its own runner group and snapshot bucket.
 */
export function configForScript(cfg: WranglerConfig, script: string): WranglerConfig {
  const bucket = script === cfg.name ? (cfg.r2_buckets?.[0]?.bucket_name ?? SNAPSHOT_BUCKET.name) : `${script}-snapshots`;
  return {
    ...cfg,
    name: script,
    vars: { ...(cfg.vars ?? {}), RUNNER_GROUP: script },
    r2_buckets: (cfg.r2_buckets ?? []).map(b => ({ ...b, bucket_name: bucket })),
  };
}

/** The snapshot bucket a config binds, for ensure_bucket. */
export function snapshotBucketOf(cfg: WranglerConfig): string | null {
  return cfg.r2_buckets?.[0]?.bucket_name ?? null;
}

/**
 * Durable Object migrations to send with an upload, given the tag the live
 * script is at (null = never deployed). Same rules as wrangler's
 * getMigrationsToUpload: nothing when already at the last tag; all steps
 * when the live tag is unknown to this config.
 */
export function migrationsToUpload(cfg: WranglerConfig, liveTag: string | null): Record<string, unknown> | undefined {
  const list = cfg.migrations;
  if (list.length === 0) return undefined;
  const steps = (from: number) => list.slice(from).map(({ tag: _tag, ...rest }) => rest);
  const newTag = list[list.length - 1]!.tag;
  if (!liveTag) return { new_tag: newTag, steps: steps(0) };
  const at = list.findIndex(m => m.tag === liveTag);
  if (at === -1) return { old_tag: liveTag, new_tag: newTag, steps: steps(0) };
  if (at === list.length - 1) return undefined;
  return { old_tag: liveTag, new_tag: newTag, steps: steps(at + 1) };
}

/** The `metadata` part of PUT /workers/scripts/{script}, as wrangler deploy builds it. */
export function workerUploadMetadata(cfg: WranglerConfig, mainModule: string, liveMigrationTag: string | null): Record<string, unknown> {
  const bindings: Array<Record<string, unknown>> = [
    ...cfg.durable_objects.bindings.map(d => ({ type: 'durable_object_namespace', name: d.name, class_name: d.class_name })),
    ...(cfg.r2_buckets ?? []).map(b => ({ type: 'r2_bucket', name: b.binding, bucket_name: b.bucket_name })),
    ...(cfg.browser ? [{ type: 'browser', name: cfg.browser.binding }] : []),
    ...(cfg.version_metadata ? [{ type: 'version_metadata', name: cfg.version_metadata.binding }] : []),
    ...Object.entries(cfg.vars ?? {}).map(([name, text]) => ({ type: 'plain_text', name, text })),
  ];
  const migrations = migrationsToUpload(cfg, liveMigrationTag);
  return {
    main_module: mainModule,
    bindings,
    containers: cfg.containers.map(c => ({ class_name: c.class_name })),
    compatibility_date: cfg.compatibility_date,
    ...(cfg.compatibility_flags ? { compatibility_flags: cfg.compatibility_flags } : {}),
    ...(migrations ? { migrations } : {}),
    // Secrets are put separately (put_secret) and must survive a code upload.
    keep_bindings: ['secret_text', 'secret_key'],
    ...(cfg.limits ? { limits: cfg.limits } : {}),
    ...(cfg.observability ? { observability: cfg.observability } : {}),
  };
}

/** The container application's name: wrangler's default, `<worker>-<class>` lower-cased. */
export function containerAppName(script: string, className: string): string {
  return `${script}-${className}`.toLowerCase().replace(/ /g, '-');
}

/** One container application as GET /containers/applications lists it (the fields read). */
export interface LiveContainerApp {
  id: string;
  name: string;
  durable_objects?: { namespace_id?: string };
  configuration?: { image?: string; instance_type?: string };
  max_instances?: number;
  rollout_active_grace_period?: number;
}

export type ContainerAppChange =
  | { action: 'create'; name: string; body: Record<string, unknown> }
  | { action: 'modify'; name: string; id: string; body: Record<string, unknown>; rollout: Record<string, unknown> | null }
  | { action: 'none'; name: string; id: string }
  | { action: 'conflict'; name: string; error: string };

/**
 * What to do for one container class: create its application, modify it
 * (with a rolling rollout when the image or size changed), or nothing. A
 * create sends what wrangler's containerConfigToCreateRequest sends under the
 * `default` scheduling policy.
 */
export function containerAppChange(
  script: string,
  c: WranglerContainer,
  image: string,
  namespaceId: string,
  logsEnabled: boolean,
  live: LiveContainerApp | undefined,
): ContainerAppChange {
  const name = containerAppName(script, c.class_name);
  const configuration = { image, instance_type: c.instance_type };
  const grace = c.rollout_active_grace_period ?? 0;
  if (!live) {
    return {
      action: 'create',
      name,
      body: {
        name,
        scheduling_policy: 'default',
        observability: { logs: { enabled: logsEnabled } },
        configuration,
        instances: 0,
        max_instances: c.max_instances,
        constraints: { tiers: [1, 2] },
        durable_objects: { namespace_id: namespaceId },
        rollout_active_grace_period: grace,
      },
    };
  }
  if (live.durable_objects?.namespace_id !== namespaceId) {
    return {
      action: 'conflict',
      name,
      error: `The container application ${name} belongs to another Durable Object namespace. Delete it in the Cloudflare dashboard (Workers & Pages → Containers), then deploy again.`,
    };
  }
  const configChanged = live.configuration?.image !== image || live.configuration?.instance_type !== c.instance_type;
  const limitsChanged = live.max_instances !== c.max_instances || (live.rollout_active_grace_period ?? 0) !== grace;
  if (!configChanged && !limitsChanged) return { action: 'none', name, id: live.id };
  // wrangler: one step for a ceiling under 2, else 10% then the rest.
  const steps = c.max_instances < 2 ? { step_percentage: 100 } : {
    steps: [10, 100].map((p, i) => ({ step_size: { percentage: p }, description: `Step ${i + 1} of 2 - rollout at ${p}% of instances` })),
  };
  return {
    action: 'modify',
    name,
    id: live.id,
    body: { configuration, max_instances: c.max_instances, rollout_active_grace_period: grace },
    rollout: configChanged
      ? { description: 'Progressive update', strategy: 'rolling', target_configuration: configuration, ...steps, kind: 'full_auto' }
      : null,
  };
}
