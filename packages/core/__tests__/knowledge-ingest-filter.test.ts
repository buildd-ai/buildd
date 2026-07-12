import { describe, it, expect } from 'bun:test';
import {
  shouldIngestFile,
  classifyIngestCorpus,
  MAX_INGEST_FILE_BYTES,
} from '../knowledge-store/ingest-filter';

describe('classifyIngestCorpus', () => {
  it('classifies markdown files as docs', () => {
    expect(classifyIngestCorpus('docs/testing.md')).toBe('docs');
    expect(classifyIngestCorpus('README.mdx')).toBe('docs');
    expect(classifyIngestCorpus('notes.markdown')).toBe('docs');
  });

  it('classifies source files as code', () => {
    expect(classifyIngestCorpus('apps/web/src/lib/github.ts')).toBe('code');
    expect(classifyIngestCorpus('src/App.tsx')).toBe('code');
    expect(classifyIngestCorpus('scripts/build.sh')).toBe('code');
    expect(classifyIngestCorpus('lib/utils.py')).toBe('code');
  });

  it('returns null for unknown / binary extensions', () => {
    expect(classifyIngestCorpus('assets/logo.png')).toBeNull();
    expect(classifyIngestCorpus('font.woff2')).toBeNull();
    expect(classifyIngestCorpus('archive.tar.gz')).toBeNull();
    expect(classifyIngestCorpus('Makefile')).toBeNull();
  });
});

describe('shouldIngestFile', () => {
  it('accepts normal source and doc files', () => {
    expect(shouldIngestFile('apps/web/src/lib/github.ts')).toBe(true);
    expect(shouldIngestFile('docs/testing.md')).toBe(true);
    expect(shouldIngestFile('packages/core/mcp-tools.ts')).toBe(true);
  });

  it('rejects test and spec files by default', () => {
    expect(shouldIngestFile('apps/web/src/app/api/foo/route.test.ts')).toBe(false);
    expect(shouldIngestFile('src/thing.spec.tsx')).toBe(false);
    expect(shouldIngestFile('lib/util.test.js')).toBe(false);
  });

  it('keeps test files when skipTests is false', () => {
    expect(shouldIngestFile('src/thing.test.ts', { skipTests: false })).toBe(true);
  });

  it('rejects files inside skip directories', () => {
    expect(shouldIngestFile('node_modules/react/index.js')).toBe(false);
    expect(shouldIngestFile('apps/web/.next/static/chunk.js')).toBe(false);
    expect(shouldIngestFile('packages/core/dist/index.js')).toBe(false);
    expect(shouldIngestFile('coverage/lcov-report/index.js')).toBe(false);
    expect(shouldIngestFile('.turbo/cache/thing.ts')).toBe(false);
  });

  it('rejects migration / generated paths', () => {
    expect(shouldIngestFile('packages/core/drizzle/0069_linear_work_tracker.sql')).toBe(false);
    expect(shouldIngestFile('db/migrations/001_init.sql')).toBe(false);
    expect(shouldIngestFile('src/__generated__/types.ts')).toBe(false);
  });

  it('rejects lockfiles', () => {
    expect(shouldIngestFile('bun.lockb')).toBe(false);
    expect(shouldIngestFile('bun.lock')).toBe(false);
    expect(shouldIngestFile('package-lock.json')).toBe(false);
    expect(shouldIngestFile('yarn.lock')).toBe(false);
    expect(shouldIngestFile('pnpm-lock.yaml')).toBe(false);
    expect(shouldIngestFile('vendor/Cargo.lock')).toBe(false);
  });

  it('rejects binaries and unknown extensions', () => {
    expect(shouldIngestFile('public/logo.png')).toBe(false);
    expect(shouldIngestFile('bin/tool')).toBe(false);
  });

  it('rejects oversized files when sizeBytes is provided', () => {
    expect(shouldIngestFile('src/big.ts', { sizeBytes: MAX_INGEST_FILE_BYTES + 1 })).toBe(false);
    expect(shouldIngestFile('src/small.ts', { sizeBytes: 1024 })).toBe(true);
  });
});
