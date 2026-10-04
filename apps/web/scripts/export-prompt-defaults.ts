/**
 * Write every registered prompt's PUBLIC default into a prompts directory in
 * the seed format (`@buildd/core/prompt-seed`): one file per id plus
 * `manifest.json`. Use it to start a deployment's own prompts directory from
 * exactly the ids this code reads, then edit the files and bump versions.
 *
 *   bun run apps/web/scripts/export-prompt-defaults.ts --out <dir> [--version N]
 *
 * Files land at `<dir>/prompts/<id>.json` (decision questions) or
 * `<dir>/prompts/<id>.md` (text), every entry at `--version` (default 1). The
 * manifest is overwritten; nothing else in the directory is touched.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Hex, type PromptManifestEntry } from '@buildd/core/prompt-seed';
import type { RegisteredPrompt } from '@buildd/core/prompts';
import { listPromptCatalog } from '../src/lib/prompt-catalog';

export function promptFileName(p: Pick<RegisteredPrompt, 'id' | 'format'>): string {
  return `prompts/${p.id}.${p.format === 'json' ? 'json' : 'md'}`;
}

export function buildDefaultsExport(
  catalog: readonly RegisteredPrompt[],
  version: number,
): { files: Record<string, string>; manifest: PromptManifestEntry[] } {
  const files: Record<string, string> = {};
  const manifest = catalog.map(p => {
    const file = promptFileName(p);
    files[file] = p.publicDefault;
    return { id: p.id, version, file, sha256: sha256Hex(p.publicDefault) };
  });
  return { files, manifest };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const out = args[args.indexOf('--out') + 1];
  const version = Number(args.includes('--version') ? args[args.indexOf('--version') + 1] : 1);
  if (!args.includes('--out') || !out) {
    console.error('usage: export-prompt-defaults.ts --out <dir> [--version N]');
    process.exit(2);
  }
  const { files, manifest } = buildDefaultsExport(listPromptCatalog(), version);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(out, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  const manifestPath = join(out, 'manifest.json');
  if (existsSync(manifestPath)) console.warn(`[prompts:export] overwriting ${manifestPath}`);
  writeFileSync(manifestPath, `${JSON.stringify({ prompts: manifest }, null, 2)}\n`);
  console.log(`[prompts:export] wrote ${manifest.length} prompt(s) to ${out}`);
}
