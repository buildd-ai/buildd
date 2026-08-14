import type { EffortDay } from '@/components/SparklineBar';
export type { EffortDay };

export interface InitiativeTriageItem {
  id: string;             // initiative UUID or "__unassigned__"
  title: string;
  progress: number;       // 0–100, task-weighted
  effortDays: EffortDay[];
  awaitingVerification: number;
  blocked: number;
  held: number;
  shippedThisWeek: number;
}
