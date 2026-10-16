/**
 * Index every already-approved Living Spec into recall and the knowledge graph
 * (lib/specs/knowledge.ts). Specs approved before indexing existed have no
 * chunks; this writes them. Idempotent: each spec's chunks and derived edges
 * are replaced, so running it again changes nothing.
 *
 * Dry run by default — lists what it would index and writes nothing.
 *
 *   bun run --cwd apps/web specs:backfill-knowledge
 *   bun run --cwd apps/web specs:backfill-knowledge --apply
 *   bun run --cwd apps/web specs:backfill-knowledge --apply --workspace <workspace id>
 *
 * Needs DATABASE_URL, and VOYAGE_API_KEY for embeddings (without it the
 * chunks are lexical-only, which recall still finds by keyword).
 */
import { db } from '@buildd/core/db';
import { specs } from '@buildd/core/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { indexApprovedSpec } from '../src/lib/specs/knowledge';

const apply = process.argv.includes('--apply');
const wsArg = process.argv[process.argv.indexOf('--workspace') + 1];
const workspaceId = process.argv.includes('--workspace') ? wsArg : undefined;

const rows = await db
  .select({ id: specs.id, title: specs.title, workspaceId: specs.workspaceId, approvedRevision: specs.approvedRevision })
  .from(specs)
  .where(workspaceId ? and(isNotNull(specs.approvedRevision), eq(specs.workspaceId, workspaceId)) : isNotNull(specs.approvedRevision));

console.log(`${rows.length} approved spec(s)${workspaceId ? ` in workspace ${workspaceId}` : ''}.`);
let failed = 0;
for (const s of rows) {
  if (!apply) {
    console.log(`  would index ${s.id.slice(0, 8)} "${s.title}" at revision ${s.approvedRevision}`);
    continue;
  }
  const r = await indexApprovedSpec(s.id);
  if (r.errors.length || !r.indexed || !r.graph) failed++;
  console.log(`  ${s.id.slice(0, 8)} "${s.title}" r${s.approvedRevision}: ${r.chunks} chunk(s), graph ${r.graph ? 'ok' : 'failed'}${r.errors.length ? ` — ${r.errors.join('; ')}` : ''}`);
}
if (!apply) console.log('Dry run. Pass --apply to write.');
process.exit(failed ? 1 : 0);
