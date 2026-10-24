import type { DesignScreen } from './screens';

/**
 * Pure planning for storing a design (Living Spec f43b6a61 R-1..R-4): which
 * revision a new export becomes, and what it is attached to. The database and
 * object-storage writes live in service.ts and follow this plan.
 */
export const DESIGN_ATTACH_KINDS = ['mission', 'task', 'spec'] as const;
export type DesignAttachKind = (typeof DESIGN_ATTACH_KINDS)[number];
export interface DesignAttachTo { kind: DesignAttachKind; id: string }

export interface DesignPlan {
  /** Set when the export is a new revision of an existing design. */
  id?: string;
  revision: number;
  screens: DesignScreen[];
  attachedTo: DesignAttachTo | null;
  bytes?: number;
}

export function planStore(input: {
  existing?: { id: string; currentRevision: number };
  screens: DesignScreen[];
  attachTo?: DesignAttachTo;
  bytes?: number;
}): DesignPlan {
  return {
    ...(input.existing ? { id: input.existing.id } : {}),
    // A new export is the next revision of the same design; a first one is 1.
    revision: input.existing ? Math.max(input.existing.currentRevision, 0) + 1 : 1,
    screens: input.screens,
    attachedTo: input.attachTo ? { kind: input.attachTo.kind, id: input.attachTo.id } : null,
    ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
  };
}

/** A pin keeps its revision; a link that follows (or has no pin) reads the current one. */
export function resolveRevision(input: { currentRevision: number; pinned?: number | null; follows?: boolean }): number {
  if (input.follows) return input.currentRevision;
  return input.pinned ?? input.currentRevision;
}

/**
 * The artifact a spec revision's `design` pins, as a design to list. A URL or
 * design-tool pin has no stored file, so it is not a design here. Pure.
 */
export function specPinnedArtifact(design: { kind: string; ref: string; version: string } | null | undefined): { artifactId: string; revision: number } | null {
  if (!design || design.kind !== 'artifact') return null;
  const revision = Number(design.version);
  return Number.isInteger(revision) && revision >= 1 ? { artifactId: design.ref, revision } : null;
}
