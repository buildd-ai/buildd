// Fixture for scripts/server-only-preload.test.ts — do not import from app code.
//
// The whole point is that this runs under a PLAIN `bun run`, with none of the
// `bun test` preload in scope. The DB layer pulls in `import 'server-only'`,
// which throws unless the specifier has been stubbed, so reaching the log line
// is the assertion: the DB layer is importable from an ordinary Bun script.
//
// Imported by relative path, like the other root-level scripts — `@buildd/core`
// is a workspace package and is not linked into the root node_modules.
import { db } from '../../packages/core/db/index';

// `db` is a lazy Proxy — touching the binding never opens a connection, so this
// probe needs no DATABASE_URL.
if (!db) throw new Error('db binding missing');
console.log('db-import-probe: ok');
