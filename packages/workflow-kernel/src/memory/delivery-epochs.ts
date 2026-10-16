/**
 * Mission epochs in memory, with the same rules as buildd's Postgres
 * statement (apps/web/src/lib/workflow/delivery-epochs.ts `applyEpochOpsSql`):
 *
 *  - one statement per transition: every op applies, or none does;
 *  - an update is a compare-and-set on the row's version, and increments it;
 *  - the unique indexes: one epoch per (mission, epoch), one successor per
 *    predecessor, one open epoch per mission;
 *  - `project_branch` moves the mission's branch only while it still names
 *    `fromBranch`.
 *
 * A violated index or a lost CAS throws `EpochConflict` and writes nothing:
 * the caller re-reads and reduces again, which is how a replayed or racing
 * merge ends as a `noop` instead of a second successor.
 */
import type { EpochOp, EpochSnapshot, MissionEpochView } from '../delivery-epochs';

export class EpochConflict extends Error {
  constructor(readonly why: 'cas_lost' | 'epoch_unique' | 'successor_unique' | 'open_unique') {
    super(`epoch write conflict: ${why}`);
    this.name = 'EpochConflict';
  }
}

export class MemoryEpochStore {
  private rows: EpochSnapshot[] = [];
  private branches = new Map<string, string | null>();
  private seq = 0;
  constructor(private readonly newId: () => string = () => `epoch-${++this.seq}`) {}

  setMissionBranch(missionId: string, branch: string | null): void { this.branches.set(missionId, branch); }
  missionBranch(missionId: string): string | null { return this.branches.get(missionId) ?? null; }
  epochs(missionId: string): EpochSnapshot[] {
    return this.rows.filter((r) => r.missionId === missionId).sort((a, b) => a.epoch - b.epoch).map((r) => ({ ...r }));
  }

  /** Apply one transition's ops atomically. Returns the rows inserted. */
  apply(ops: EpochOp[]): EpochSnapshot[] {
    const rows = this.rows.map((r) => ({ ...r }));
    const branches = new Map(this.branches);
    const inserted: EpochSnapshot[] = [];
    for (const op of ops) {
      if (op.op === 'insert') {
        const e = op.epoch;
        const predecessorId = e.predecessorId
          ?? (e.predecessorEpoch != null ? rows.find((r) => r.missionId === e.missionId && r.epoch === e.predecessorEpoch)?.id ?? null : null);
        if (rows.some((r) => r.missionId === e.missionId && r.epoch === e.epoch)) throw new EpochConflict('epoch_unique');
        if (predecessorId && rows.some((r) => r.predecessorId === predecessorId)) throw new EpochConflict('successor_unique');
        if (e.state === 'open' && rows.some((r) => r.missionId === e.missionId && r.state === 'open')) throw new EpochConflict('open_unique');
        const { predecessorEpoch: _p, ...fields } = e;
        const row: EpochSnapshot = { ...fields, id: this.newId(), version: 0, predecessorId, settlement: null };
        rows.push(row);
        inserted.push(row);
      } else if (op.op === 'update') {
        const row = rows.find((r) => r.id === op.epochId);
        if (!row || row.version !== op.expectVersion) throw new EpochConflict('cas_lost');
        Object.assign(row, op.set, { version: row.version + 1 });
        if (row.state === 'open' && rows.some((r) => r !== row && r.missionId === row.missionId && r.state === 'open')) throw new EpochConflict('open_unique');
      } else {
        if ((branches.get(op.missionId) ?? null) === op.fromBranch) branches.set(op.missionId, op.branch);
      }
    }
    this.rows = rows;
    this.branches = branches;
    return inserted.map((r) => ({ ...r }));
  }

  /** The view a host would load, with the caller's work counts. */
  view(base: Omit<MissionEpochView, 'epochs' | 'integrationBranch'>): MissionEpochView {
    return { ...base, integrationBranch: this.missionBranch(base.missionId), epochs: this.epochs(base.missionId) };
  }
}
