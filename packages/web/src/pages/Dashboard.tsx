import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, Folder, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import type { Workspace } from '@buildd/shared';
import { useState } from 'react';

export function Dashboard() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');

  const { data: workspaces, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<Workspace[]>('/api/workspaces'),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => api.post('/api/workspaces', { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setShowCreate(false);
      setName('');
    },
  });

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-72 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <h1 className="text-xl font-bold text-white">buildd</h1>
          <p className="text-sm text-gray-400">Agent orchestration</p>
        </div>

        <div className="p-3">
          <button
            onClick={() => setShowCreate(true)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium"
          >
            <Plus className="h-4 w-4" />
            New Workspace
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {isLoading ? (
            <div className="text-gray-500 text-sm p-2">Loading...</div>
          ) : (
            workspaces?.map((ws) => (
              <Link
                key={ws.id}
                to={`/workspace/${ws.id}`}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-800 text-gray-300 hover:text-white group"
              >
                <Folder className="h-4 w-4 text-gray-500" />
                <span className="flex-1 truncate">{ws.name}</span>
                <span className="text-xs text-gray-500">{ws.taskCount || 0}</span>
                <ChevronRight className="h-4 w-4 text-gray-600 opacity-0 group-hover:opacity-100" />
              </Link>
            ))
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 p-8">
        <h2 className="text-2xl font-bold mb-6">Workspaces</h2>
        
        {workspaces?.length === 0 && !isLoading && (
          <div className="text-center py-12">
            <Folder className="h-12 w-12 mx-auto text-gray-600 mb-4" />
            <p className="text-gray-400">No workspaces yet</p>
            <button
              onClick={() => setShowCreate(true)}
              className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm"
            >
              Create your first workspace
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {workspaces?.map((ws) => (
            <Link
              key={ws.id}
              to={`/workspace/${ws.id}`}
              className="p-4 bg-gray-900 border border-gray-800 rounded-lg hover:border-gray-700"
            >
              <h3 className="font-medium text-white">{ws.name}</h3>
              <p className="text-sm text-gray-400 mt-1">
                {ws.taskCount || 0} tasks · {ws.activeWorkerCount || 0} active workers
              </p>
            </Link>
          ))}
        </div>
      </main>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-96">
            <h3 className="text-lg font-medium mb-4">New Workspace</h3>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workspace name"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg mb-4"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 text-gray-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => createMutation.mutate(name)}
                disabled={!name.trim()}
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
