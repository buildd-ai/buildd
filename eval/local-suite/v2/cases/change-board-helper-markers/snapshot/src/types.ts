export type Marker = Record<string, unknown>;

/** A task row as a page loads it. */
export interface RawTask {
  id: string;
  title: string;
  status: string;
  /** Full context, where a caller has it. */
  context?: Marker | null;
  /** The mission page loads a digest of the context under this key. */
  contextDigest?: Marker | null;
}

export interface BoardTaskInput {
  id: string;
  title: string;
  status: string;
  context?: Marker | null;
}

export interface Cell {
  id: string;
  label: string;
  status: string;
}
