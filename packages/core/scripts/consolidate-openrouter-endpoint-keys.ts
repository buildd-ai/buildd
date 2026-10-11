#!/usr/bin/env bun
/**
 * One stored OpenRouter key per scope: turn every `agent_endpoint` row of kind
 * `openrouter` that carries its own inline `apiKey` into a reference to the
 * stored OpenRouter key (`inference_key`/`openrouter`, or its legacy
 * `decision_key`) at the same scope or broader. Provider parity §2 step 5.
 *
 * Per row, comparing against the key the reference would resolve to
 * (`resolveStoredOpenRouterKey`, the same lookup `resolveAgentEndpoint` makes):
 *
 *   - equal                 → strip the inline key (the row becomes a reference);
 *   - nothing stored        → create `inference_key`/`openrouter` at the row's
 *                             scope from the inline key, then strip;
 *   - a different key       → leave the key in place and set
 *                             `capabilities.legacyInlineKey = true`, so Settings
 *                             asks someone to pick one.
 *
 * Workspace rows go before team rows, so a workspace endpoint with no stored
 * key gets its own at its scope rather than being compared against a team key
 * this same run just created.
 *
 * References, other kinds and rows already flagged (still different) are left
 * alone, so a second run changes nothing. Every write is one atomic statement
 * (`UPDATE ... WHERE encrypted_value = <what was read> RETURNING`, an
 * `INSERT ... WHERE NOT EXISTS ... RETURNING`), never `db.transaction()`
 * (neon-http). A row edited between read and write is skipped and counted, and
 * the next run picks it up.
 *
 * Creating a team's stored OpenRouter key also makes it that team's chat and
 * inference key (that is the point: one key, every surface).
 *
 * Output is counts only: never a key, a row id or a team.
 *
 *   bun packages/core/scripts/consolidate-openrouter-endpoint-keys.ts           # dry run (default)
 *   bun packages/core/scripts/consolidate-openrouter-endpoint-keys.ts --apply   # write
 *
 * Needs DATABASE_URL and ENCRYPTION_KEY for the environment being changed.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { secrets } from '../db/schema';
import { decrypt, encrypt } from '../secrets';
import {
  AGENT_ENDPOINT_PURPOSE,
  parseAgentEndpointBlob,
  resolveStoredOpenRouterKey,
  serializeAgentEndpoint,
  type AgentEndpointBlob,
} from '../agent-endpoint';

export const OPENROUTER_LABEL = 'openrouter' as const;
/** The canonical OpenRouter key purpose (the registry's `openrouter` api_key storage). */
const INFERENCE_KEY_PURPOSE = 'inference_key' as const;

export interface ConsolidationCounts {
  /** `agent_endpoint` rows read (team-owned: no account, no person). */
  scanned: number;
  /** Not OpenRouter (gateway, custom URL). */
  otherKind: number;
  /** Already a reference. */
  alreadyReference: number;
  /** Inline key equal to the stored one: stripped. */
  stripped: number;
  /** Nothing stored: OpenRouter key created at the row's scope, then stripped. */
  created: number;
  /** Stored key differs: flagged `legacyInlineKey`. */
  flagged: number;
  /** Stored key differs and the row was already flagged. */
  alreadyFlagged: number;
  /** Could not be decrypted or parsed. */
  unreadable: number;
  /** Changed between read and write (or a concurrent create): skipped, picked up next run. */
  raced: number;
  /** The stored-key lookup or a write failed. */
  failed: number;
}

export function emptyCounts(): ConsolidationCounts {
  return { scanned: 0, otherKind: 0, alreadyReference: 0, stripped: 0, created: 0, flagged: 0, alreadyFlagged: 0, unreadable: 0, raced: 0, failed: 0 };
}

type OpenRouterBlob = Extract<AgentEndpointBlob, { kind: 'openrouter' }>;

/** The blob as a reference: no inline key, and no backfill flag. */
export function asReference(blob: OpenRouterBlob): OpenRouterBlob {
  const { apiKey: _key, ...rest } = blob;
  const caps = { ...(rest.capabilities ?? {}) };
  delete caps.legacyInlineKey;
  const out: OpenRouterBlob = { ...rest };
  if (Object.keys(caps).length > 0) out.capabilities = caps;
  else delete out.capabilities;
  return out;
}

/** The blob, left inline, flagged as differing from the stored key. */
export function asFlagged(blob: OpenRouterBlob): OpenRouterBlob {
  return { ...blob, capabilities: { ...(blob.capabilities ?? {}), legacyInlineKey: true } };
}

interface EndpointRow {
  id: string;
  teamId: string;
  workspaceId: string | null;
  encryptedValue: string;
}

/** Rewrite one endpoint row iff it still holds exactly what was read. */
async function compareAndSet(row: EndpointRow, blob: OpenRouterBlob): Promise<boolean> {
  const updated = await db.update(secrets)
    .set({ encryptedValue: encrypt(serializeAgentEndpoint(blob)), updatedAt: new Date() })
    .where(and(
      eq(secrets.id, row.id),
      eq(secrets.purpose, AGENT_ENDPOINT_PURPOSE),
      eq(secrets.encryptedValue, row.encryptedValue),
    ))
    .returning({ id: secrets.id });
  return updated.length > 0;
}

/**
 * Create the OpenRouter key at exactly this scope (team-wide when
 * `workspaceId` is null; never account- or person-scoped), unless one already
 * exists there. One statement, so two concurrent runs create one row.
 */
async function createStoredKey(row: EndpointRow, key: string): Promise<boolean> {
  const workspaceMatch = row.workspaceId ? sql`workspace_id = ${row.workspaceId}::uuid` : sql`workspace_id IS NULL`;
  const result = await db.execute(sql`
    INSERT INTO secrets (team_id, workspace_id, purpose, label, encrypted_value)
    SELECT ${row.teamId}::uuid, ${row.workspaceId}::uuid, ${INFERENCE_KEY_PURPOSE}, ${OPENROUTER_LABEL}, ${encrypt(key)}
    WHERE NOT EXISTS (
      SELECT 1 FROM secrets
      WHERE team_id = ${row.teamId}::uuid AND ${workspaceMatch}
        AND account_id IS NULL AND user_id IS NULL
        AND purpose = ${INFERENCE_KEY_PURPOSE} AND label = ${OPENROUTER_LABEL}
    )
    RETURNING id`);
  return (((result as { rows?: unknown[] }).rows) ?? []).length > 0;
}

export async function consolidateOpenRouterEndpointKeys(opts: { apply: boolean; teamId?: string | null }): Promise<ConsolidationCounts> {
  const counts = emptyCounts();
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, AGENT_ENDPOINT_PURPOSE),
      isNull(secrets.accountId),
      isNull(secrets.userId),
      ...(opts.teamId ? [eq(secrets.teamId, opts.teamId)] : []),
    ),
    columns: { id: true, teamId: true, workspaceId: true, accountId: true, userId: true, purpose: true, encryptedValue: true },
  });

  // Workspace rows first: a workspace endpoint with no key of its own gets one
  // at its own scope, before a team key created for the team row would make it
  // read as "a different key" and be flagged for no reason.
  const ordered = [...rows].sort((x, y) => Number(!x.workspaceId) - Number(!y.workspaceId));
  for (const row of ordered) {
    // Re-checked in code: a loose query never widens what is rewritten.
    if (row.purpose !== AGENT_ENDPOINT_PURPOSE || row.accountId || row.userId) continue;
    counts.scanned++;

    let blob: AgentEndpointBlob | null;
    try {
      blob = parseAgentEndpointBlob(decrypt(row.encryptedValue));
    } catch {
      blob = null;
    }
    if (!blob) { counts.unreadable++; continue; }
    if (blob.kind !== 'openrouter') { counts.otherKind++; continue; }
    const inline = blob.apiKey?.trim();
    if (!inline) { counts.alreadyReference++; continue; }

    try {
      const stored = await resolveStoredOpenRouterKey({ teamId: row.teamId, workspaceId: row.workspaceId });
      if (stored && stored.key === inline) {
        if (opts.apply && !(await compareAndSet(row, asReference(blob)))) { counts.raced++; continue; }
        counts.stripped++;
      } else if (!stored) {
        if (opts.apply) {
          if (!(await createStoredKey(row, inline))) { counts.raced++; continue; }
          if (!(await compareAndSet(row, asReference(blob)))) { counts.raced++; continue; }
        }
        counts.created++;
      } else if (blob.capabilities?.legacyInlineKey === true) {
        counts.alreadyFlagged++;
      } else {
        if (opts.apply && !(await compareAndSet(row, asFlagged(blob)))) { counts.raced++; continue; }
        counts.flagged++;
      }
    } catch {
      // The error could carry decrypted material; record nothing of it.
      counts.failed++;
    }
  }
  return counts;
}

export function formatCounts(counts: ConsolidationCounts, apply: boolean): string {
  const verb = apply ? '' : 'would be ';
  return [
    `${apply ? 'APPLIED' : 'DRY RUN (pass --apply to write)'}: OpenRouter agent endpoint keys`,
    `  endpoint rows scanned:            ${counts.scanned}`,
    `  not OpenRouter:                   ${counts.otherKind}`,
    `  already a reference:              ${counts.alreadyReference}`,
    `  ${verb}stripped (key matched):        ${counts.stripped}`,
    `  ${verb}created + stripped (no key):   ${counts.created}`,
    `  ${verb}flagged (different key):       ${counts.flagged}`,
    `  already flagged:                  ${counts.alreadyFlagged}`,
    `  unreadable:                       ${counts.unreadable}`,
    `  changed mid-run (re-run):         ${counts.raced}`,
    `  failed:                           ${counts.failed}`,
  ].join('\n');
}

async function main() {
  // Resolved inside main(): a top-level exit would fire on mere import.
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set');
    process.exit(1);
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.error('ERROR: ENCRYPTION_KEY is not set');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const teamArg = process.argv.indexOf('--team');
  const teamId = teamArg !== -1 ? process.argv[teamArg + 1] ?? null : null;
  const counts = await consolidateOpenRouterEndpointKeys({ apply, teamId });
  console.log(formatCounts(counts, apply));
  if (counts.failed > 0) process.exit(2);
}

if (import.meta.main) {
  main().catch(() => {
    // Never print the error: it could carry decrypted material.
    console.error('FAILED: the backfill stopped before finishing; re-run to resume (it is idempotent).');
    process.exit(1);
  });
}
