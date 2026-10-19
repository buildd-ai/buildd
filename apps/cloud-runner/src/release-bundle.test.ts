import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PULLABLE_IMAGE_RE, configForScript, containerAppChange, containerAppName, migrationsToUpload, parseReleaseBundle,
  parseWranglerConfig, releaseBundleAssetName, releaseConfig, snapshotBucketOf, workerUploadMetadata, type LiveContainerApp,
} from './release-bundle';
import { SNAPSHOT_BUCKET } from './deploy-plan';
import { RUNNER_CLASSES } from './runner-class';

const TEXT = readFileSync(join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8');
const IMAGE = `docker.io/buildd/runner-once@sha256:${'a'.repeat(64)}`;

function bundle(over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    tag: 'v1.2.3',
    image: IMAGE,
    config: releaseConfig(TEXT, IMAGE),
    mainModule: 'index.js',
    modules: [{ name: 'index.js', content: 'export default {}' }],
    ...over,
  };
}

describe('release config', () => {
  it('every container class runs the published image and nothing is built', () => {
    const cfg = releaseConfig(TEXT, IMAGE);
    expect(cfg.containers.length).toBeGreaterThan(0);
    for (const c of cfg.containers) {
      expect(c.image).toBe(IMAGE);
      expect(c.image_build_context).toBeUndefined();
    }
    // Both runner sizes stay deployable.
    expect(new Set(cfg.containers.map(c => c.class_name))).toEqual(new Set(Object.values(RUNNER_CLASSES).map(c => c.binding)));
  });

  it('the asset is named after the tag', () => {
    expect(releaseBundleAssetName('v1.2.3')).toBe('cloud-runner-v1.2.3.json');
  });

  it('only a digest-pinned Docker Hub image counts as pullable', () => {
    expect(PULLABLE_IMAGE_RE.test(IMAGE)).toBe(true);
    expect(PULLABLE_IMAGE_RE.test('docker.io/buildd/runner-once:v1.2.3')).toBe(false);
    expect(PULLABLE_IMAGE_RE.test(`ghcr.io/buildd-ai/runner-once@sha256:${'a'.repeat(64)}`)).toBe(false);
  });
});

describe('parseReleaseBundle', () => {
  it('accepts a bundle for the expected tag', () => {
    const r = parseReleaseBundle(bundle(), 'v1.2.3');
    expect(r.ok).toBe(true);
  });

  it('accepts a release with no pullable image (the deploy refuses at the container step)', () => {
    const r = parseReleaseBundle(bundle({ image: null }), 'v1.2.3');
    expect(r.ok && r.bundle.image).toBeNull();
  });

  it.each([
    ['another tag', { tag: 'v9.9.9' }, /not v1\.2\.3/],
    ['a newer schema', { schema: 2 }, /schema 2/],
    ['a GHCR image', { image: `ghcr.io/x/y@sha256:${'a'.repeat(64)}` }, /Docker Hub/],
    ['a path-like module', { modules: [{ name: '../index.js', content: '' }] }, /plain name/],
    ['a missing main module', { mainModule: 'other.js' }, /main module/],
  ])('refuses %s', (_label, over, error) => {
    const r = parseReleaseBundle(bundle(over), 'v1.2.3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
  });

  it('refuses a container class with no Durable Object behind it', () => {
    const cfg = releaseConfig(TEXT, IMAGE);
    const r = parseReleaseBundle(bundle({ config: { ...cfg, durable_objects: { bindings: [] } } }), 'v1.2.3');
    expect(r.ok).toBe(false);
  });
});

describe('configForScript', () => {
  const cfg = parseWranglerConfig(TEXT);

  it('the default name keeps wrangler.jsonc\'s bucket', () => {
    const out = configForScript(cfg, cfg.name);
    expect(snapshotBucketOf(out)).toBe(SNAPSHOT_BUCKET.name);
    expect(out.vars?.RUNNER_GROUP).toBe(cfg.name);
  });

  it('another name gets its own bucket and runner group, like deploy.ts --name', () => {
    const out = configForScript(cfg, 'eval-runner');
    expect(out.name).toBe('eval-runner');
    expect(snapshotBucketOf(out)).toBe('eval-runner-snapshots');
    expect(out.vars?.RUNNER_GROUP).toBe('eval-runner');
    expect(cfg.name).toBe('buildd-cloud-runner'); // the input is untouched
  });
});

describe('migrationsToUpload (wrangler getMigrationsToUpload)', () => {
  const cfg = parseWranglerConfig(TEXT);
  const last = cfg.migrations[cfg.migrations.length - 1]!.tag;

  it('a new script gets every step', () => {
    expect(migrationsToUpload(cfg, null)).toEqual({ new_tag: last, steps: cfg.migrations.map(({ tag: _t, ...r }) => r) });
  });

  it('a script at the last tag gets none', () => {
    expect(migrationsToUpload(cfg, last)).toBeUndefined();
  });

  it('a script at an earlier tag gets the steps after it', () => {
    const r = migrationsToUpload(cfg, cfg.migrations[0]!.tag) as { old_tag: string; steps: unknown[] };
    expect(r.old_tag).toBe(cfg.migrations[0]!.tag);
    expect(r.steps).toHaveLength(cfg.migrations.length - 1);
  });
});

describe('workerUploadMetadata', () => {
  const cfg = parseWranglerConfig(TEXT);
  const m = workerUploadMetadata(cfg, 'index.js', null) as Record<string, any>;

  it('binds every Durable Object, the bucket, the browser, version metadata and the vars', () => {
    const types = (m.bindings as Array<{ type: string; name: string }>).map(b => `${b.type}:${b.name}`);
    for (const d of cfg.durable_objects.bindings) expect(types).toContain(`durable_object_namespace:${d.name}`);
    expect(types).toContain('r2_bucket:SNAPSHOTS');
    expect(types).toContain('browser:BROWSER');
    expect(types).toContain('version_metadata:CF_VERSION_METADATA');
    expect(types).toContain('plain_text:RUNNER_GROUP');
  });

  it('links each container class, keeps secrets and carries the CPU limit', () => {
    expect(m.containers).toEqual(cfg.containers.map(c => ({ class_name: c.class_name })));
    expect(m.keep_bindings).toEqual(['secret_text', 'secret_key']);
    expect(m.limits).toEqual(cfg.limits);
    expect(m.main_module).toBe('index.js');
    expect(m.migrations).toBeDefined();
  });
});

describe('containerAppChange', () => {
  const c = releaseConfig(TEXT, IMAGE).containers[0]!;
  const name = containerAppName('buildd-cloud-runner', c.class_name);
  const live = (over: Partial<LiveContainerApp> = {}): LiveContainerApp => ({
    id: 'app-1', name, durable_objects: { namespace_id: 'ns-1' },
    configuration: { image: IMAGE, instance_type: c.instance_type },
    max_instances: c.max_instances, rollout_active_grace_period: c.rollout_active_grace_period, ...over,
  });

  it('names the application the way wrangler does', () => {
    expect(name).toBe('buildd-cloud-runner-workeragent');
  });

  it('creates a missing application under the default policy, bound to its namespace', () => {
    const ch = containerAppChange('buildd-cloud-runner', c, IMAGE, 'ns-1', true, undefined);
    expect(ch.action).toBe('create');
    if (ch.action !== 'create') return;
    expect(ch.body).toMatchObject({
      name, scheduling_policy: 'default', configuration: { image: IMAGE, instance_type: c.instance_type },
      max_instances: c.max_instances, durable_objects: { namespace_id: 'ns-1' }, rollout_active_grace_period: c.rollout_active_grace_period,
    });
  });

  it('does nothing when the live application already matches', () => {
    expect(containerAppChange('buildd-cloud-runner', c, IMAGE, 'ns-1', true, live()).action).toBe('none');
  });

  it('a new image modifies the application and rolls it out', () => {
    const ch = containerAppChange('buildd-cloud-runner', c, IMAGE, 'ns-1', true, live({ configuration: { image: 'old', instance_type: c.instance_type } }));
    expect(ch.action).toBe('modify');
    if (ch.action !== 'modify') return;
    expect(ch.rollout).toMatchObject({ strategy: 'rolling', kind: 'full_auto', target_configuration: { image: IMAGE } });
  });

  it('a new ceiling modifies without a rollout', () => {
    const ch = containerAppChange('buildd-cloud-runner', c, IMAGE, 'ns-1', true, live({ max_instances: 1 }));
    expect(ch.action === 'modify' && ch.rollout).toBeNull();
  });

  it('an application bound to another namespace is a conflict, not an overwrite', () => {
    const ch = containerAppChange('buildd-cloud-runner', c, IMAGE, 'ns-1', true, live({ durable_objects: { namespace_id: 'ns-other' } }));
    expect(ch.action).toBe('conflict');
  });
});
