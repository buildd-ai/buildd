export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm">
        <h1 className="text-4xl font-bold mb-4">buildd</h1>
        <p className="text-lg mb-8">Distributed AI dev team orchestration</p>

        <div className="grid grid-cols-2 gap-4 w-full max-w-4xl">
          <div className="border border-gray-200 dark:border-gray-800 p-6 rounded-lg">
            <h2 className="text-xl font-semibold mb-2">Accounts</h2>
            <p className="text-gray-600 dark:text-gray-400">
              Create user, service, or action accounts
            </p>
          </div>

          <div className="border border-gray-200 dark:border-gray-800 p-6 rounded-lg">
            <h2 className="text-xl font-semibold mb-2">Workspaces</h2>
            <p className="text-gray-600 dark:text-gray-400">
              Manage project workspaces
            </p>
          </div>

          <div className="border border-gray-200 dark:border-gray-800 p-6 rounded-lg">
            <h2 className="text-xl font-semibold mb-2">Tasks</h2>
            <p className="text-gray-600 dark:text-gray-400">
              View and create tasks
            </p>
          </div>

          <div className="border border-gray-200 dark:border-gray-800 p-6 rounded-lg">
            <h2 className="text-xl font-semibold mb-2">Workers</h2>
            <p className="text-gray-600 dark:text-gray-400">
              Monitor active agents
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
