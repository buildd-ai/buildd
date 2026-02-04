"use client";

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[#2a2d3a] text-white">
      {/* Hero Section */}
      <div className="max-w-6xl mx-auto px-6 pt-16 pb-12">
        <div className="text-center space-y-6">
          {/* Hero Logo */}
          <div className="relative mx-auto w-full max-w-md md:max-w-lg lg:max-w-xl">
            <picture>
              <source
                media="(min-width: 1024px)"
                srcSet="/hero/logo-desktop.webp"
                type="image/webp"
              />
              <source
                media="(min-width: 768px)"
                srcSet="/hero/logo-tablet.webp"
                type="image/webp"
              />
              <source srcSet="/hero/logo-mobile.webp" type="image/webp" />
              <img
                src="/hero/logo-desktop.png"
                alt="Buildd"
                className="w-full h-auto"
                width={1600}
                height={1194}
              />
            </picture>
          </div>

          {/* Badges */}
          <div className="flex flex-wrap justify-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-white/10 border border-white/20 rounded-full text-sm text-gray-300">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
              Open Source
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-white/10 border border-white/20 rounded-full text-sm text-gray-300">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              Self-Hostable
            </span>
          </div>

          <div className="space-y-3">
            <p className="text-xl md:text-2xl text-gray-300 max-w-2xl mx-auto">
              Task Queue for AI Agents
            </p>
            <p className="text-lg text-gray-400">
              Create tasks. Agents work. Code ships.
            </p>
          </div>
        </div>
      </div>

      {/* Install Section */}
      <div className="max-w-4xl mx-auto px-6 pb-12">
        <div className="bg-[#1a1c24] rounded-xl border border-white/10 overflow-hidden">
          {/* Terminal header */}
          <div className="flex items-center gap-2 px-4 py-3 bg-white/5 border-b border-white/10">
            <div className="w-3 h-3 rounded-full bg-red-500/80" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
            <div className="w-3 h-3 rounded-full bg-green-500/80" />
            <span className="ml-2 text-sm text-gray-500">Terminal</span>
          </div>
          {/* Install command */}
          <div className="p-6">
            <div className="flex items-center gap-3">
              <span className="text-gray-500 select-none">$</span>
              <code className="text-gray-200 font-mono text-sm md:text-base flex-1">
                curl -fsSL https://buildd.dev/install.sh | bash
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText('curl -fsSL https://buildd.dev/install.sh | bash');
                }}
                className="p-2 hover:bg-white/10 rounded-lg transition-colors text-gray-400 hover:text-white"
                title="Copy to clipboard"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Secondary links */}
        <div className="flex flex-wrap justify-center gap-4 mt-6 text-sm">
          <a
            href="https://github.com/buildd-ai/buildd"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
            View on GitHub
          </a>
          <span className="text-gray-600">·</span>
          <a
            href="/app"
            className="text-gray-400 hover:text-white transition-colors"
          >
            Dashboard
          </a>
        </div>
      </div>

      {/* Screenshot */}
      <div className="max-w-3xl mx-auto px-6 pb-16">
        <div className="rounded-xl overflow-hidden border border-white/10 shadow-2xl shadow-black/50">
          <img
            src="/local-ui.png"
            alt="Buildd local UI showing an active worker"
            className="w-full h-auto"
          />
        </div>
      </div>

      {/* Features Section */}
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid md:grid-cols-3 gap-8">
          <div className="bg-white/5 rounded-xl p-6 border border-white/10 backdrop-blur-sm">
            <div className="w-12 h-12 bg-fuchsia-500/20 rounded-lg flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-fuchsia-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-2">Multi-Agent Coordination</h3>
            <p className="text-gray-400">
              Run Claude agents on laptops, VMs, or GitHub Actions.
              One dashboard controls them all.
            </p>
          </div>

          <div className="bg-white/5 rounded-xl p-6 border border-white/10 backdrop-blur-sm">
            <div className="w-12 h-12 bg-violet-500/20 rounded-lg flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-violet-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-2">GitHub-Native</h3>
            <p className="text-gray-400">
              Agents create branches, commit code, and open PRs automatically.
              Full webhook integration.
            </p>
          </div>

          <div className="bg-white/5 rounded-xl p-6 border border-white/10 backdrop-blur-sm">
            <div className="w-12 h-12 bg-cyan-500/20 rounded-lg flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-cyan-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-2">Real-Time Control</h3>
            <p className="text-gray-400">
              Monitor progress, costs, and send instructions to running agents mid-task.
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-white/10">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-gray-400 text-sm">
              buildd - Open source task queue for AI agents
            </p>
            <div className="flex gap-6 text-sm text-gray-400">
              <a
                href="https://github.com/buildd-ai/buildd"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-white transition-colors"
              >
                GitHub
              </a>
              <a
                href="mailto:hello@buildd.dev"
                className="hover:text-white transition-colors"
              >
                Contact
              </a>
              <a
                href="mailto:hello@buildd.dev?subject=Enterprise%20Inquiry"
                className="hover:text-white transition-colors"
              >
                Enterprise
              </a>
              <a
                href="/app"
                className="hover:text-white transition-colors"
              >
                Sign In
              </a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
