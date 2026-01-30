import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Circle, Play, Pause } from 'lucide-react';
import { api } from '../api/client';
import type { Task, Workspace } from '@buildd/shared';
import { useState } from 'react';

const statusColors: Record<string, string> = {
  pending: 'text-gray-400',
  assigned: 'text-yellow-400',
  in_progress: 'text-blue-400',
  review: 'text-purple-400',
  completed: 'text-green-400',
  failed: 'text-red-400',
};

export function Workspace() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');

  const { data: workspace } = useQuery({
    queryKey: ['workspaces', id],
    queryFn: () => api.get<Workspace>(`/api/workspaces/${id}`),
  });

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['tasks', { workspaceId: id }],
    queryFn: () => api.get<Task[]>('/api/tasks', { workspaceId: id }),
  });

  const createTask = useMutation({
    mutationFn: (title: string) => api.post('/api/tasks', { workspaceId: id, title }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setShowCreate(false);
      setTitle('');
    },
  });

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-72 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <Link to="/" className="flex items-center gap-2 text-gray-400 hover:text-white mb-2">
            <ArrowLeft className="h-4 w-4" />
            <span className="text-sm">Back</span>
          </Link>
          <h1 className="text-lg font-bold text-white">{workspace?.name || 'Loading...'}</h1>
        </div>

        <div className="p-3">
          <button
            onClick={() => setShowCreate(true)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium"
          >
            <Plus className="h-4 w-4" />
            New Task
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {isLoading ? (
            <div className="text-gray-500 text-sm p-2">Loading...</div>
          ) : (
            tasks?.map((task) => (
              <Link
                key={task.id}
                to={`/task/${task.id}`}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-800 text-gray-300 hover:text-white"
              >
                <Circle className={`h-2 w-2 ${statusColors[task.status]} fill-current`} />
                <span className="flex-1 truncate">{task.title}</span>
                {task.worker && (
                  <span className="text-xs text-gray-500">
                    {task.worker.status === 'running' ? (
                      <Play className="h-3 w-3 text-green-400" />
                    ) : (
                      <Pause className="h-3 w-3 text-gray-500" />
                    )}
                  </span>
                )}
              </Link>
            ))
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 p-8">
        <h2 className="text-2xl font-bold mb-6">Tasks</h2>

        {tasks?.length === 0 && !isLoading && (
          <div className="text-center py-12">
            <p className="text-gray-400">No tasks yet</p>
            <button
              onClick={() => setShowCreate(true)}
              className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm"
            >
              Create your first task
            </button>
          </div>
        )}

        <div className="space-y-2">
          {tasks?.map((task) => (
            <Link
              key={task.id}
              to={`/task/${task.id}`}
              className="flex items-center gap-4 p-4 bg-gray-900 border border-gray-800 rounded-lg hover:border-gray-700"
            >
              <Circle className={`h-3 w-3 ${statusColors[task.status]} fill-current`} />
              <div className="flex-1">
                <h3 className="font-medium text-white">{task.title}</h3>
                <p className="text-sm text-gray-400">{task.status}</p>
              </div>
              {task.worker && (
                <div className="text-right">
                  <p className="text-sm text-gray-400">{task.worker.name}</p>
                  <p className="text-xs text-gray-500">{task.worker.progress}% · ${Number(task.worker.costUsd).toFixed(4)}</p>
                </div>
              )}
            </Link>
          ))}
        </div>
      </main>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-96">
            <h3 className="text-lg font-medium mb-4">New Task</h3>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg mb-4"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-gray-400 hover:text-white">
                Cancel
              </button>
              <button
                onClick={() => createTask.mutate(title)}
                disabled={!title.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
