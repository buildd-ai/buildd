'use client';

interface HistoryEntry {
  type: 'instruction' | 'response';
  message: string;
  timestamp: number;
  deliveryState?: 'pending' | 'delivered';
}

interface InstructionHistoryProps {
  history: HistoryEntry[];
}

export default function InstructionHistory({ history }: InstructionHistoryProps) {
  if (!history.length) {
    return null;
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="mt-4 pt-4 border-t border-border-default">
      <h4 className="text-sm font-medium text-text-secondary mb-2">Communication</h4>

      <div className="space-y-2 max-h-48 overflow-y-auto">
        {history.map((entry, i) => {
          const isPending = entry.type === 'instruction' && entry.deliveryState === 'pending';

          return (
            <div
              key={`${entry.timestamp}-${i}`}
              className={`flex gap-2 text-sm ${
                entry.type === 'instruction' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[80%] px-3 py-2 rounded-lg ${
                  isPending
                    ? 'bg-status-warning/10 text-status-warning border border-status-warning/20'
                    : entry.type === 'instruction'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-surface-3 text-text-primary'
                }`}
              >
                <p className="break-words">{entry.message}</p>
                <p className={`text-xs mt-1 ${
                  isPending
                    ? 'text-status-warning/70'
                    : entry.type === 'instruction'
                      ? 'text-primary/60'
                      : 'text-text-muted'
                }`}>
                  {entry.type === 'instruction' ? 'You' : 'Worker'} · {formatTime(entry.timestamp)}
                  {isPending && ' · Pending delivery'}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
