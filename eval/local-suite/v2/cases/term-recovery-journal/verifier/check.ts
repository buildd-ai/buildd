import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = process.env.CANDIDATE_DIR!;
const BACKUP_SHA = '92dc5e6d3262cda547376b8d267cdc868a2fc9f6a40b5fb7fc035f2af6ebf82a';
const bad: string[] = [];
const read = (base: string, p: string) => JSON.parse(readFileSync(join(base, p), 'utf8'));
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

const WANT = {
  schemaVersion: 3,
  accounts: [
    { id: 'a1', firstName: 'Ana', lastName: 'Ruiz', balanceCents: 1250 },
    { id: 'a2', firstName: 'Ben van', lastName: 'Dyk', balanceCents: 29 },
    { id: 'a3', firstName: 'Cleo', lastName: 'Marsh', balanceCents: 115 },
    { id: 'a4', firstName: 'Dev', lastName: 'Patel', balanceCents: 0 },
  ],
};

try {
  if (canon(read(dir, 'data/accounts.json')) !== canon(WANT)) bad.push('data/accounts.json is not the fully migrated data (accounts lost, balances converted twice or not at all)');
} catch {
  bad.push('data/accounts.json unreadable');
}
try {
  const done: number[] = read(dir, '.migrate/journal.json').done ?? [];
  if (JSON.stringify([...done].sort()) !== '[1,2,3]') bad.push(`journal must list steps 1, 2 and 3 once each, has ${JSON.stringify(done)}`);
} catch {
  bad.push('.migrate/journal.json unreadable');
}
try {
  if (createHash('sha256').update(readFileSync(join(dir, 'data/accounts.backup.json'))).digest('hex') !== BACKUP_SHA) bad.push('data/accounts.backup.json was modified');
} catch {
  bad.push('data/accounts.backup.json is missing');
}

// A repeat of the interruption must be harmless: run the script again, twice, in a copy.
const copy = mkdtempSync(join(tmpdir(), 'migrate-rerun-'));
try {
  cpSync(dir, copy, { recursive: true });
  const before = canon(read(copy, 'data/accounts.json'));
  for (let i = 0; i < 2; i++) {
    const r = Bun.spawnSync(['bun', 'scripts/migrate.ts'], { cwd: copy, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) {
      bad.push('re-running scripts/migrate.ts does not exit 0');
      break;
    }
  }
  try {
    if (canon(read(copy, 'data/accounts.json')) !== before) bad.push('re-running scripts/migrate.ts changed the data');
  } catch {
    bad.push('re-running scripts/migrate.ts corrupted the data');
  }
} catch {
  bad.push('could not re-run scripts/migrate.ts');
} finally {
  rmSync(copy, { recursive: true, force: true });
}

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('ok');
