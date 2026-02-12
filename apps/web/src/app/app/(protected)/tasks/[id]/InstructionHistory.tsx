'use client';

interface HistoryEntry {
  type: 'instruction' | 'response';
  message: string;
  timestamp: number;
}

interface InstructionHistoryProps {
  history: HistoryEntry[];
  pendingInstruction?: string | null;
}

export default function InstructionHistory({ history, pendingInstruction }: InstructionHistoryProps) {
  if (!history.length && !pendingInstruction) {
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
        {history.map((entry, i) => (
          <div
            key={`${entry.timestamp}-${i}`}
            className={`flex gap-2 text-sm ${
              entry.type === 'instruction' ? 'justify-end' : 'justify-start'
            }`}
          >
            <div
              className={`max-w-[80%] px-3 py-2 rounded-lg ${
                entry.type === 'instruction'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-surface-3 text-text-primary'
              }`}
            >
              <p className="break-words">{entry.message}</p>
              <p className={`text-xs mt-1 ${
                entry.type === 'instruction'
                  ? 'text-primary/60'
                  : 'text-text-muted'
              }`}>
                {entry.type === 'instruction' ? 'You' : 'Worker'} · {formatTime(entry.timestamp)}
              </p>
            </div>
          </div>
        ))}

        {/* Pending instruction indicator */}
        {pendingInstruction && (
          <div className="flex gap-2 justify-end">
            <div className="max-w-[80%] px-3 py-2 rounded-lg bg-status-warning/10 text-status-warning border border-status-warning/20">
              <p className="break-words">{pendingInstruction}</p>
              <p className="text-xs mt-1 text-status-warning/70">
                Pending delivery...
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
