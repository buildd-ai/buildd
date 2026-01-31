'use client';

import { useState } from 'react';

interface Milestone {
  label: string;
  timestamp: number;
}

interface WorkerActivityTimelineProps {
  milestones: Milestone[];
  currentAction?: string | null;
  maxVisible?: number;
}

export default function WorkerActivityTimeline({
  milestones,
  currentAction,
  maxVisible = 5,
}: WorkerActivityTimelineProps) {
  const [expanded, setExpanded] = useState(false);

  if (!milestones.length && !currentAction) {
    return null;
  }

  // Sort milestones by timestamp (newest first for display)
  const sortedMilestones = [...milestones].sort((a, b) => b.timestamp - a.timestamp);
  const visibleMilestones = expanded ? sortedMilestones : sortedMilestones.slice(0, maxVisible);
  const hasMore = sortedMilestones.length > maxVisible;

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  };

  const getIcon = (label: string) => {
    const lower = label.toLowerCase();
    if (lower.includes('commit')) return '📝';
    if (lower.includes('edit') || lower.includes('write')) return '✏️';
    if (lower.includes('read')) return '📖';
    if (lower.includes('test')) return '🧪';
    if (lower.includes('build')) return '🔨';
    if (lower.includes('error') || lower.includes('fail')) return '❌';
    if (lower.includes('complete') || lower.includes('done')) return '✅';
    if (lower.includes('start')) return '🚀';
    if (lower.includes('search') || lower.includes('grep')) return '🔍';
    if (lower.includes('install')) return '📦';
    return '•';
  };

  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium text-gray-500 mb-2">Activity</h4>

      {/* Current action - highlighted */}
      {currentAction && (
        <div className="flex items-start gap-2 mb-3 p-2 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800">
          <span className="text-blue-500 animate-pulse">●</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-blue-700 dark:text-blue-300 truncate">
              {currentAction}
            </p>
            <p className="text-xs text-blue-500">now</p>
          </div>
        </div>
      )}

      {/* Milestones timeline */}
      {visibleMilestones.length > 0 && (
        <div className="space-y-1">
          {visibleMilestones.map((milestone, i) => (
            <div
              key={`${milestone.timestamp}-${i}`}
              className="flex items-start gap-2 py-1 text-sm"
            >
              <span className="w-5 text-center flex-shrink-0">
                {getIcon(milestone.label)}
              </span>
              <span className="flex-1 text-gray-700 dark:text-gray-300 truncate">
                {milestone.label}
              </span>
              <span className="text-xs text-gray-400 flex-shrink-0">
                {formatTime(milestone.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Expand/collapse button */}
      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          {expanded
            ? 'Show less'
            : `Show ${sortedMilestones.length - maxVisible} more...`}
        </button>
      )}

      {/* Summary stats */}
      {sortedMilestones.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500">
          {sortedMilestones.length} actions recorded
        </div>
      )}
    </div>
  );
}
