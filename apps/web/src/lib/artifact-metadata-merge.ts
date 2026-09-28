/**
 * PATCH /api/artifacts/[artifactId] metadata semantics
 * (docs/design/visual-qa-human-review.md, "PATCH integrity fix"): top-level
 * keys shallow-merge onto the stored metadata, and `qa` deep-merges one level,
 * so update_artifact {metadata: {qa: {fixTaskId}}} keeps the shot's route,
 * viewport, finding and the upload's filename. A wholesale replace used to
 * erase them, and the shot silently dropped out of the evidence check.
 *
 * The route merges in SQL (`artifactMetadataMergeSql`), against the row the
 * UPDATE itself sees, so two overlapping PATCHes of one shot (an auditor's
 * fix link and a caption edit) cannot lose either. `mergeArtifactMetadata` is
 * the same rule in JS, for callers holding a value and for the tests.
 */
import { sql, type SQL } from 'drizzle-orm';
import { artifacts } from '@buildd/core/db/schema';

type Json = Record<string, unknown>;
export const isJsonObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function mergeArtifactMetadata(stored: unknown, patch: Json): Json {
  const base = isJsonObject(stored) ? stored : {};
  const merged: Json = { ...base, ...patch };
  if (isJsonObject(patch.qa) && isJsonObject(base.qa)) merged.qa = { ...base.qa, ...patch.qa };
  return merged;
}

/** The SET expression for `artifacts.metadata`. Stored metadata that is not an object counts as `{}`. */
export function artifactMetadataMergeSql(patch: Json): SQL {
  const col = artifacts.metadata;
  const stored = sql`(case when jsonb_typeof(${col}) = 'object' then ${col} else '{}'::jsonb end)`;
  const shallow = sql`(${stored} || ${JSON.stringify(patch)}::jsonb)`;
  if (!isJsonObject(patch.qa)) return shallow;
  const storedQa = sql`(case when jsonb_typeof(${col} -> 'qa') = 'object' then ${col} -> 'qa' else '{}'::jsonb end)`;
  return sql`jsonb_set(${shallow}, '{qa}', ${storedQa} || ${JSON.stringify(patch.qa)}::jsonb)`;
}
