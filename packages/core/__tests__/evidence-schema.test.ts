/**
 * Unit test: evidence storage tables and configuration are correctly wired.
 *
 * Verifies that:
 * - evidenceBackends and evidenceObjects tables are exported from schema
 * - SecretPurpose accepts 'evidence_storage_credential'
 * - The migration creates both tables with expected columns
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evidenceBackends,
  evidenceObjects,
} from '../db/schema';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

describe('evidence storage schema', () => {
  test('evidenceBackends table is exported from schema', () => {
    expect(evidenceBackends).toBeDefined();
    expect(typeof evidenceBackends).toBe('object');
  });

  test('evidenceObjects table is exported from schema', () => {
    expect(evidenceObjects).toBeDefined();
    expect(typeof evidenceObjects).toBe('object');
  });

  test('schema includes evidence_storage_credential purpose in SecretPurpose', () => {
    const schemaSrc = read('packages/core/db/schema.ts');
    expect(schemaSrc).toContain("'evidence_storage_credential'");
  });

  test('migration 0213 creates evidence_backends table', () => {
    const migrationSrc = read('packages/core/drizzle/0213_overconfident_red_ghost.sql');
    expect(migrationSrc).toContain('CREATE TABLE "evidence_backends"');
    expect(migrationSrc).toContain('"id" uuid PRIMARY KEY');
    expect(migrationSrc).toContain('"bucket" text NOT NULL');
    expect(migrationSrc).toContain('"endpoint" text');
    expect(migrationSrc).toContain('"region" text');
    expect(migrationSrc).toContain('"prefix" text');
    expect(migrationSrc).toContain('"kms_key_id" text');
    expect(migrationSrc).toContain('"last_error" text');
  });

  test('migration 0213 creates evidence_objects table', () => {
    const migrationSrc = read('packages/core/drizzle/0213_overconfident_red_ghost.sql');
    expect(migrationSrc).toContain('CREATE TABLE "evidence_objects"');
    expect(migrationSrc).toContain('"id" uuid PRIMARY KEY');
    expect(migrationSrc).toContain('"object_key" text NOT NULL');
    expect(migrationSrc).toContain('"sha256" text');
    expect(migrationSrc).toContain('"workspace_id" uuid NOT NULL');
    expect(migrationSrc).toContain('"task_id" uuid NOT NULL');
  });

  test('storage-keys exports buildEvidenceObjectKey', () => {
    const keySrc = read('apps/web/src/lib/storage-keys.ts');
    expect(keySrc).toContain('export function buildEvidenceObjectKey');
  });
});
