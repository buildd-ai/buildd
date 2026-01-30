import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Play, Pause, Square, Send, FileText, Code, Image } from 'lucide-react';
import { api } from '../api/client';
import { useWorkerSSE } from '../hooks/useSSE';
import type { Task, Artifact } from '@buildd/shared';
import { useState, useEffect } from 'react';

const statusColors: Record<string, string> = {
  idle: 'bg-gray-500',
  starting: 'bg-yellow-500 animate-pulse',
  running: 'bg-green-500 animate-pulse',
  waiting_input: 'bg-blue-500 animate-pulse',
  paused: 'bg-orange-500',
  completed: 'bg-green-600',
  error: 'bg-red-500',
};

const artifactIcons: Record<string, typeof FileText> = {
  task_plan: FileText,
  impl_plan: FileText,
  diff: Code,
  screenshot: Image,
  summary: FileText,
};

export function Task() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);

  const { data: task, isLoading } = useQuery({
    queryKey: ['tasks', id],
    queryFn: () => api.get<Task>(`/api/tasks/${id}`),
    refetchInterval: 5000,
  });

  const worker = task?.worker;
  const { events } = useWorkerSSE(worker?.id || '');

  useEffect(() => {
    if (events.length > 0) {
      queryClient.invalidateQueries({ queryKey: ['tasks', id] });
    }
  }, [events, queryClient, id]);

  const createWorker = useMutation({
    mutationFn: () => api.post('/api/workers', { workspaceId: task?.workspaceId, taskId: id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks', id] }),
  });

  const startWorker = useMutation({
    mutationFn: (p: string) => api.post(`/api/workers/${worker?.id}/start`, { prompt: p }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks', id] });
      setPrompt('');
    },
  });

  const pauseWorker = useMutation({
    mutationFn: () => api.post(`/api/workers/${worker?.id}/pause`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks', id] }),
  });

  const cancelWorker = useMutation({
    mutationFn: () => api.post(`/api/workers/${worker?.id}/cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks', id] }),
  });

  if (isLoading) return <div className="p-8 text-gray-400">Loading...</div>;
  if (!task) return <div className="p-8 text-red-400">Task not found</div>;

  return (
    <div className="flex h-screen">
      <div className="flex-1 flex flex-col border-r border-gray-800">
        <header className="p-4 border-b border-gray-800">
          <Link to={`/workspace/${task.workspaceId}`} className="flex items-center gap-2 text-gray-400 hover:text-white mb-2">
            <ArrowLeft className="h-4 w-4" />
            <span className="text-sm">Back</span>
          </Link>
          <h1 className="text-xl font-bold text-white">{task.title}</h1>
          <p className="text-sm text-gray-400 mt-1">{task.status}</p>
        </header>

        <div className="flex-1 p-4 overflow-y-auto">
          {!worker ? (
            <div className="text-center py-12">
              <p className="text-gray-400 mb-4">No worker assigned</p>
              <button onClick={() => createWorker.mutate()} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg">
                Assign Worker
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-gray-900 rounded-lg">
                <div className={`h-3 w-3 rounded-full ${statusColors[worker.status]}`} />
                <div className="flex-1">
                  <p className="font-medium">{worker.name}</p>
                  <p className="text-sm text-gray-400">{worker.status}</p>
                </div>
                <div className="text-right text-sm">
                  <p>{worker.progress}%</p>
                  <p className="text-gray-500">${Number(worker.costUsd).toFixed(4)}</p>
                </div>
              </div>

              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${worker.progress}%` }} />
              </div>

              <div className="flex gap-2">
                {worker.status === 'idle' && (
                  <button onClick={() => startWorker.mutate(prompt || `Complete: ${task.title}`)} className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg">
                    <Play className="h-4 w-4" /> Start
                  </button>
                )}
                {worker.status === 'running' && (
                  <button onClick={() => pauseWorker.mutate()} className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 rounded-lg">
                    <Pause className="h-4 w-4" /> Pause
                  </button>
                )}
                {['running', 'waiting_input', 'paused'].includes(worker.status) && (
                  <button onClick={() => cancelWorker.mutate()} className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg">
                    <Square className="h-4 w-4" /> Cancel
                  </button>
                )}
              </div>

              {worker.status === 'waiting_input' && worker.waitingFor && (
                <div className="p-4 bg-blue-900/20 border border-blue-800 rounded-lg">
                  <p className="text-blue-300 mb-2">{worker.waitingFor.prompt}</p>
                  <div className="flex gap-2">
                    <input type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Your response..." className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg" />
                    <button className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg"><Send className="h-4 w-4" /></button>
                  </div>
                </div>
              )}

              {worker.status === 'idle' && (
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Instructions for the worker..." className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg h-24 resize-none" />
              )}

              {worker.status === 'error' && worker.error && (
                <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-300">{worker.error}</div>
              )}
            </div>
          )}
        </div>
      </div>

      <aside className="w-80 bg-gray-900 flex flex-col">
        <header className="p-4 border-b border-gray-800">
          <h2 className="font-medium">Artifacts</h2>
        </header>
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {(!worker?.artifacts || worker.artifacts.length === 0) && <p className="text-gray-500 text-sm p-2">No artifacts yet</p>}
          {worker?.artifacts?.map((a) => {
            const Icon = artifactIcons[a.type] || FileText;
            return (
              <button key={a.id} onClick={() => setSelectedArtifact(a)} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left ${selectedArtifact?.id === a.id ? 'bg-blue-600' : 'hover:bg-gray-800'}`}>
                <Icon className="h-4 w-4" />
                <span className="flex-1 truncate text-sm">{a.title || a.type.replace('_', ' ')}</span>
              </button>
            );
          })}
        </div>
        {selectedArtifact && (
          <div className="border-t border-gray-800 p-4 max-h-96 overflow-y-auto">
            <h3 className="font-medium mb-2">{selectedArtifact.title || selectedArtifact.type}</h3>
            {selectedArtifact.content && (
              <pre className="text-xs text-gray-300 whitespace-pre-wrap bg-gray-800 p-2 rounded">
                {selectedArtifact.content.slice(0, 1000)}{selectedArtifact.content.length > 1000 && '...'}
              </pre>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
