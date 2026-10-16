#!/usr/bin/env bun
/**
 * Refuse a hand edit to a generated spec copy (docs/specs/living-specs.md §18,
 * R-16, AC-75).
 *
 * A file in docs/specs carrying `generated_from` is buildd's copy of a native
 * spec: its approved text must hash to `content_hash` and its metadata block
 * to `metadata_hash`. Any edit, `domain:` included, breaks one of them, and
 * this fails naming the spec's short id and printing the link where the spec
 * is edited instead. The generated PR always passes, because buildd wrote
 * both hashes from the text it wrote. Offline: no call to buildd (R-17).
 *
 * Usage: bun run scripts/check-generated-specs.ts
 * BUILDD_APP_URL overrides the link's host (default https://buildd.dev).
 */
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { verifyRepoCopy } from '../packages/spec-contract/src/repo-copy';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface GeneratedSpecFinding {
  file: string;
  shortId: string;
  message: string;
}

/** Every generated copy among `files` that is not exactly what buildd wrote. */
export async function checkGeneratedSpecs(files: ReadonlyArray<{ file: string; text: string }>, baseUrl: string): Promise<{ generated: number; findings: GeneratedSpecFinding[] }> {
  const findings: GeneratedSpecFinding[] = [];
  let generated = 0;
  for (const { file, text } of files) {
    const v = await verifyRepoCopy(text);
    if (!v.generated) continue;
    generated++;
    if (v.ok) continue;
    const link = `${baseUrl.replace(/\/+$/, '')}/app/specs/${v.shortId}`;
    findings.push({
      file,
      shortId: v.shortId,
      message: `${file} is generated from spec ${v.shortId} and was edited by hand (${v.problems.join('; ')}). This spec is edited in buildd, not in the repo: ${link}`,
    });
  }
  return { generated, findings };
}

if (import.meta.main) {
  const dir = join(ROOT, 'docs/specs');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => ({ file: `docs/specs/${f}`, text: readFileSync(join(dir, f), 'utf8') }));
  const { generated, findings } = await checkGeneratedSpecs(files, process.env.BUILDD_APP_URL || 'https://buildd.dev');
  for (const f of findings) console.error(`✖ ${f.message}`);
  console.log(`generated spec copies: ${generated} checked, ${findings.length} edited by hand`);
  process.exit(findings.length ? 1 : 0);
}
