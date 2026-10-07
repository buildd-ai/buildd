'use client';

import { useDisplayTimezone } from '@/components/DisplayTimezone';
import { formatInZone } from '@/lib/zoned-time';
import {
  DELIVERY_STATE_LABEL,
  deliveryStateDetail,
  messageDeliveryStatus,
  type InstructionHistoryEntry,
  type MessageDeliveryState,
} from '@/lib/worker-instructions';

interface InstructionHistoryProps {
  history: InstructionHistoryEntry[];
  /** The worker's status: a message the run never read is "Not delivered" once it ends. */
  workerStatus?: string | null;
  /** Offered on undelivered messages only: send the text to the run that is live now. */
  onResend?: (message: string) => void;
  resending?: boolean;
  title?: string;
  testId?: string;
}

/** Glyph + word: the state never rests on colour alone. */
const GLYPH: Record<MessageDeliveryState, string> = {
  queued: '◷',
  delivered: '→',
  acknowledged: '✓',
  undelivered: '✕',
};

const TONE: Record<MessageDeliveryState, string> = {
  queued: 'text-status-warning',
  delivered: 'text-text-secondary',
  acknowledged: 'text-status-success',
  undelivered: 'text-status-error',
};

export function DeliveryStateChip({ state }: { state: MessageDeliveryState }) {
  return (
    <span
      data-testid="message-delivery-state"
      data-state={state}
      title={deliveryStateDetail(state)}
      className={`inline-flex items-center gap-1 text-[11px] font-medium ${TONE[state]}`}
    >
      <span aria-hidden="true">{GLYPH[state]}</span>
      {DELIVERY_STATE_LABEL[state]}
    </span>
  );
}

export default function InstructionHistory({
  history,
  workerStatus = null,
  onResend,
  resending = false,
  title = 'Communication',
  testId,
}: InstructionHistoryProps) {
  const displayTz = useDisplayTimezone();

  if (!history.length) {
    return null;
  }

  const formatTime = (timestamp: number) => {
    return displayTz ? formatInZone(timestamp, displayTz, 'time') : '';
  };

  return (
    <div data-testid={testId} className="mt-4 pt-4 border-t border-border-default">
      <h4 className="text-sm font-medium text-text-secondary mb-2">{title}</h4>

      <div className="space-y-2 max-h-48 overflow-y-auto">
        {history.map((entry, i) => {
          const isInstruction = entry.type === 'instruction';
          // The one derivation every surface uses; never the stored field.
          const state = isInstruction ? messageDeliveryStatus(entry, workerStatus).state : null;

          return (
            <div
              key={entry.id ?? `${entry.timestamp}-${i}`}
              className={`flex gap-2 text-sm ${isInstruction ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] px-3 py-2 rounded-lg ${
                  isInstruction ? 'bg-primary/10 text-primary' : 'bg-surface-3 text-text-primary'
                }`}
              >
                <p className="break-words [overflow-wrap:anywhere]">{entry.message ?? '(hidden in a sensitive workspace)'}</p>
                <p className={`text-xs mt-1 flex flex-wrap items-center gap-x-1.5 ${isInstruction ? 'text-primary/60' : 'text-text-muted'}`}>
                  <span>{isInstruction ? 'You' : 'Worker'} · {formatTime(entry.timestamp)}</span>
                  {state && <DeliveryStateChip state={state} />}
                </p>
                {state === 'undelivered' && onResend && entry.message && (
                  <button
                    type="button"
                    data-testid="message-resend"
                    disabled={resending}
                    onClick={() => onResend(entry.message!)}
                    className="mt-2 min-h-11 px-3 text-[12px] font-medium border border-border-default text-text-secondary hover:border-text-primary hover:text-text-primary disabled:opacity-50"
                  >
                    {resending ? 'Resending…' : 'Resend to this run'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
