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
import { createTableColumns, loadMigrationSources } from '../db/migrate-drift';
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

  // The creating migration (0226) was squashed into drizzle/0000_baseline.sql,
  // a pg_dump; read columns through the drift gate's own CREATE TABLE parser so
  // the assertion holds whichever migration creates them.
  const createdColumns = () =>
    new Set(
      loadMigrationSources(join(REPO_ROOT, 'packages/core/drizzle')).flatMap((src) =>
        src.statements.flatMap((stmt) => createTableColumns(stmt))
      )
    );

  test('migrations create the evidence_backends table', () => {
    const cols = createdColumns();
    for (const c of ['id', 'bucket', 'endpoint', 'region', 'prefix', 'kms_key_id', 'last_error']) {
      expect(cols.has(`evidence_backends.${c}`)).toBe(true);
    }
  });

  test('migrations create the evidence_objects table', () => {
    const cols = createdColumns();
    for (const c of ['id', 'object_key', 'sha256', 'workspace_id', 'task_id']) {
      expect(cols.has(`evidence_objects.${c}`)).toBe(true);
    }
  });

  test('storage-keys exports buildEvidenceObjectKey', () => {
    const keySrc = read('apps/web/src/lib/storage-keys.ts');
    expect(keySrc).toContain('export function buildEvidenceObjectKey');
  });
});
