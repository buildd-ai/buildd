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
    <div className="mt-4 pt-4 border-t border-green-200 dark:border-green-800">
      <h4 className="text-sm font-medium text-gray-500 mb-2">Communication</h4>

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
                  ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
              }`}
            >
              <p className="break-words">{entry.message}</p>
              <p className={`text-xs mt-1 ${
                entry.type === 'instruction'
                  ? 'text-blue-500'
                  : 'text-gray-500'
              }`}>
                {entry.type === 'instruction' ? 'You' : 'Worker'} · {formatTime(entry.timestamp)}
              </p>
            </div>
          </div>
        ))}

        {/* Pending instruction indicator */}
        {pendingInstruction && (
          <div className="flex gap-2 justify-end">
            <div className="max-w-[80%] px-3 py-2 rounded-lg bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-200 border border-yellow-300 dark:border-yellow-700">
              <p className="break-words">{pendingInstruction}</p>
              <p className="text-xs mt-1 text-yellow-600 dark:text-yellow-400">
                Pending delivery...
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
