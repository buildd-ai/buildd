export type Marker = Record<string, unknown>;

export interface RawTask {
  id: string;
  title: string;
  status: string;
  context?: Marker | null;
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

export const pickContext = (t: RawTask): Marker | null =>
  t.context !== undefined && t.context !== null
    ? t.context
    : (t.contextDigest ?? null);
