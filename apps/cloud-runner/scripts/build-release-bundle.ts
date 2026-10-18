#!/usr/bin/env bun
/**
 * Build the cloud runner release asset (src/release-bundle.ts) for one tag:
 *
 *   bun apps/cloud-runner/scripts/build-release-bundle.ts --tag vX.Y.Z --out <file> [--image docker.io/…@sha256:…]
 *
 * Bundles the Worker with `wrangler deploy --dry-run` from a copy of
 * wrangler.jsonc whose container classes run `--image`, so nothing is built
 * or pushed and the bundle names the image it ships with. Without `--image`
 * (no Docker Hub mirror this release) the asset records `image: null` and a
 * server-side deploy stops at the container step, saying why.
 *
 * Run by publish-runner-image.yml after the image is pushed. Needs no
 * Cloudflare token.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PULLABLE_IMAGE_RE, RELEASE_BUNDLE_SCHEMA, RELEASE_TAG_RE, releaseConfig, type ReleaseBundle } from '../src/release-bundle';

const APP_DIR = join(dirname(new URL(import.meta.url).pathname), '..');
/** Generated next to wrangler.jsonc so `main` still resolves; gitignored. */
const RELEASE_CONFIG = 'wrangler.release.jsonc';
/** Any pullable reference works for bundling; the real one is recorded in the asset. */
const PLACEHOLDER_IMAGE = 'docker.io/library/busybox:latest';

function die(msg: string): never {
  console.error(`build-release-bundle: ${msg}`);
  process.exit(1);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) die(`${name} needs a value`);
  return v;
}

async function main() {
  const argv = process.argv.slice(2);
  const tag = arg(argv, '--tag');
  const out = arg(argv, '--out');
  const image = arg(argv, '--image') || null;
  if (!tag || !RELEASE_TAG_RE.test(tag)) die('--tag vX.Y.Z is required');
  if (!out) die('--out <file> is required');
  if (image && !PULLABLE_IMAGE_RE.test(image)) die(`--image must be a digest-pinned Docker Hub reference (docker.io/<org>/<repo>@sha256:…), not ${image}`);

  const config = releaseConfig(readFileSync(join(APP_DIR, 'wrangler.jsonc'), 'utf8'), image ?? PLACEHOLDER_IMAGE);
  writeFileSync(join(APP_DIR, RELEASE_CONFIG), JSON.stringify(config, null, 2));
  const outdir = mkdtempSync(join(tmpdir(), 'cloud-runner-bundle-'));
  try {
    const proc = Bun.spawn(['bunx', 'wrangler', 'deploy', '--dry-run', '--outdir', outdir, '--config', RELEASE_CONFIG], {
      cwd: APP_DIR, stdout: 'pipe', stderr: 'pipe',
      // Bundling needs no account; keep any token in this shell away from wrangler.
      env: { ...process.env, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' },
    });
    const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) die(`wrangler deploy --dry-run failed:\n${o}${e}`);

    // JS modules only: source maps and wrangler's README stay out of the upload.
    const files = readdirSync(outdir);
    const other = files.filter(f => !/\.(m?js|map)$/.test(f) && f !== 'README.md');
    if (other.length) die(`the bundle has modules this asset cannot carry as text: ${other.join(', ')}`);
    const modules = files
      .filter(f => /\.m?js$/.test(f))
      .map(name => ({ name, content: readFileSync(join(outdir, name), 'utf8') }));
    const mainModule = 'index.js';
    if (!modules.some(m => m.name === mainModule)) die(`wrangler wrote no ${mainModule} (got ${modules.map(m => m.name).join(', ') || 'nothing'})`);

    const bundle: ReleaseBundle = { schema: RELEASE_BUNDLE_SCHEMA, tag, image, config, mainModule, modules };
    writeFileSync(out, JSON.stringify(bundle));
    const bytes = modules.reduce((n, m) => n + Buffer.byteLength(m.content), 0);
    console.log(`wrote ${out}: ${modules.length} module(s), ${bytes} bytes, image ${image ?? 'none (no Docker Hub mirror)'}`);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
    rmSync(join(APP_DIR, RELEASE_CONFIG), { force: true });
  }
}

if (import.meta.main) {
  main().catch(err => die(err instanceof Error ? err.message : String(err)));
}
