// Migrates data/accounts.json to schema 3, one step at a time. A step that the
// journal lists as done is skipped. Run from the repository root.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DATA = 'data/accounts.json';
const JOURNAL = '.migrate/journal.json';

type Account = Record<string, any>;
interface Db {
  schemaVersion: number;
  accounts: Account[];
}

const load = (): Db => JSON.parse(readFileSync(DATA, 'utf8'));
const save = (db: Db) => writeFileSync(DATA, JSON.stringify(db, null, 2) + '\n');
const journal = (): { done: number[] } => (existsSync(JOURNAL) ? JSON.parse(readFileSync(JOURNAL, 'utf8')) : { done: [] });
function mark(n: number) {
  const j = journal();
  j.done.push(n);
  mkdirSync('.migrate', { recursive: true });
  writeFileSync(JOURNAL, JSON.stringify(j) + '\n');
}

const steps: Record<number, (db: Db) => void> = {
  // 1: split fullName into firstName and lastName (the last word is the last name)
  1(db) {
    for (const a of db.accounts) {
      if (a.fullName === undefined) continue; // already split
      const parts = a.fullName.split(' ');
      a.lastName = parts.pop();
      a.firstName = parts.join(' ');
      delete a.fullName;
    }
  },
  // 2: balance in dollars becomes balanceCents, an integer
  2(db) {
    for (const a of db.accounts) {
      if (a.balance === undefined) continue; // already converted by an interrupted run
      a.balanceCents = Math.round(a.balance * 100);
      delete a.balance;
    }
  },
  // 3: stamp the new schema version
  3(db) {
    db.schemaVersion = 3;
  },
};

for (const n of [1, 2, 3]) {
  if (journal().done.includes(n)) continue;
  const db = load();
  steps[n](db);
  save(db);
  mark(n);
  console.log(`step ${n} done`);
}
console.log('migration complete');
