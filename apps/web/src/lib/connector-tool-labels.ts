/**
 * The words and shapes a connector's tool list shows (connector-tool-review.ts
 * decides them). No server imports, so the settings panel can use it in the
 * browser.
 */

/** Where a tool's class came from, in the order the gateway checks. */
export type ToolClassSource = 'admin' | 'provider' | 'catalog' | 'name' | 'default';

export const TOOL_SOURCE_LABEL: Record<ToolClassSource, string> = {
  admin: 'Admin override',
  provider: 'Provider annotation',
  catalog: 'Catalog-vetted',
  name: 'Tool name',
  default: 'Not annotated',
};

export interface ConnectorToolRow {
  name: string;
  /** The gateway's class for the tool when listed. */
  cls: 'read' | 'query' | 'write' | 'admin' | 'denied';
  source: ToolClassSource;
  /** The admin's own marks, which the toggles change. */
  adminReadOnly: boolean;
  adminDenied: boolean;
  /** Listed by the provider in the last `tools/list` the gateway saw. */
  listed: boolean;
  /** Refused recently only because buildd did not know it reads. */
  refused: boolean;
}
