/**
 * UX Polish — connection popover, enhanced empty state with recent sessions.
 * Loaded after app.js.
 */

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatRelTime(ts) {
  if (!ts) return 'never';
  const diffMs = Date.now() - ts;
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDuration(ms) {
  if (!ms) return '-';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatCost(usd) {
  if (!usd || usd === 0) return '';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ============================================================
// Connection Popover
// ============================================================

let popoverVisible = false;
let lastConnectedAt = null;

function setupConnectionPopover() {
  const dot = document.getElementById('connectionDot');
  if (!dot) return;

  dot.style.cursor = 'pointer';
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleConnectionPopover();
  });

  // Track connection times
  const origShowStatus = window.showConnectionStatus;
  if (typeof origShowStatus === 'function' && !origShowStatus._uxPatched) {
    window.showConnectionStatus = function(connected) {
      if (connected) lastConnectedAt = Date.now();
      origShowStatus(connected);
    };
    window.showConnectionStatus._uxPatched = true;
  }

  // Close popover on outside click
  document.addEventListener('click', () => {
    if (popoverVisible) closeConnectionPopover();
  });
}

function toggleConnectionPopover() {
  if (popoverVisible) {
    closeConnectionPopover();
  } else {
    showConnectionPopover();
  }
}

function showConnectionPopover() {
  closeConnectionPopover();

  const dot = document.getElementById('connectionDot');
  if (!dot) return;

  const connected = typeof sseConnected !== 'undefined' ? sseConnected : false;
  const serverUrl = typeof config !== 'undefined' ? (config.builddServer || 'Not configured') : 'Unknown';
  const outboxBadge = document.getElementById('outboxBadge');
  const outboxCount = outboxBadge ? parseInt(outboxBadge.textContent) || 0 : 0;

  const popover = document.createElement('div');
  popover.id = 'connectionPopover';
  popover.className = 'absolute left-0 top-full mt-2 bg-surface border border-border-default rounded-xl shadow-[0_8px_32px_rgb(var(--color-overlay)/var(--shadow-strength))] p-4 min-w-[240px] z-[101] text-sm';
  popover.onclick = (e) => e.stopPropagation();

  popover.innerHTML = `
    <div class="flex items-center gap-2 mb-3">
      <span class="w-2.5 h-2.5 rounded-full ${connected ? 'bg-status-success' : 'bg-status-warning animate-pulse'}"></span>
      <span class="font-medium text-text-primary">${connected ? 'Connected' : 'Reconnecting...'}</span>
    </div>
    <div class="space-y-2 text-xs text-text-secondary">
      <div class="flex justify-between">
        <span>Server</span>
        <span class="text-text-primary font-mono truncate max-w-[150px]" title="${escapeHtml(serverUrl)}">${escapeHtml(serverUrl.replace('https://', ''))}</span>
      </div>
      ${lastConnectedAt ? `
        <div class="flex justify-between">
          <span>Last connected</span>
          <span class="text-text-primary">${formatRelTime(lastConnectedAt)}</span>
        </div>
      ` : ''}
      ${outboxCount > 0 ? `
        <div class="flex justify-between">
          <span>Pending sync</span>
          <span class="text-status-warning font-medium">${outboxCount} item${outboxCount !== 1 ? 's' : ''}</span>
        </div>
      ` : ''}
    </div>
  `;

  // Position relative to header
  dot.parentElement.style.position = 'relative';
  dot.parentElement.appendChild(popover);
  popoverVisible = true;
}

function closeConnectionPopover() {
  const existing = document.getElementById('connectionPopover');
  if (existing) existing.remove();
  popoverVisible = false;
}

// ============================================================
// Enhanced Empty State — recent sessions from history
// ============================================================

let recentSessionsLoaded = false;

/**
 * Enhance the empty state hero by adding recent sessions from SQLite history.
 * Called when the empty hero becomes visible.
 */
async function enhanceEmptyState() {
  const emptyHero = document.getElementById('emptyHero');
  if (!emptyHero || emptyHero.classList.contains('hidden')) return;

  // Only load once per page load
  if (recentSessionsLoaded) return;
  recentSessionsLoaded = true;

  try {
    const res = await fetch('./api/history?limit=3&sort=completed_at&dir=desc');
    if (!res.ok) return;
    const data = await res.json();
    const sessions = data.sessions || [];

    if (sessions.length === 0) return;

    // Check if recentSessions container already exists
    if (document.getElementById('recentSessionsEmpty')) return;

    const container = document.createElement('div');
    container.id = 'recentSessionsEmpty';
    container.className = 'w-full max-w-[400px] mt-6';

    container.innerHTML = `
      <div class="text-[10px] font-mono font-medium text-text-tertiary uppercase tracking-[2.5px] mb-2 text-left">Recent sessions</div>
      <div class="flex flex-col gap-1.5">
        ${sessions.map(s => {
          const isError = s.status === 'error';
          const statusIcon = isError
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5 text-status-error shrink-0"><path d="M18 6L6 18M6 6l12 12"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5 text-status-success shrink-0"><polyline points="20 6 9 17 4 12"/></svg>`;
          const cost = formatCost(s.total_cost_usd);
          const duration = formatDuration(s.duration_ms);

          return `
            <div class="flex items-center gap-2.5 p-2.5 rounded-lg bg-surface hover:bg-surface-hover transition-colors cursor-pointer text-left"
              onclick="window._historyModule?.openSession('${s.id}')">
              ${statusIcon}
              <div class="flex-1 min-w-0">
                <div class="text-[13px] text-text-primary truncate">${escapeHtml(s.task_title)}</div>
                <div class="text-[11px] text-text-tertiary">${escapeHtml(s.workspace_name)}${duration ? ' &bull; ' + duration : ''}${cost ? ' &bull; ' + cost : ''}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    emptyHero.appendChild(container);
  } catch {
    // Non-fatal — empty state still works without recent sessions
  }
}

// Observe empty hero visibility to trigger enhancement
function watchEmptyState() {
  const emptyHero = document.getElementById('emptyHero');
  if (!emptyHero) return;

  // Use MutationObserver to detect when emptyHero becomes visible
  const observer = new MutationObserver(() => {
    if (!emptyHero.classList.contains('hidden')) {
      enhanceEmptyState();
    }
  });
  observer.observe(emptyHero, { attributes: true, attributeFilter: ['class'] });

  // Also check immediately
  if (!emptyHero.classList.contains('hidden')) {
    enhanceEmptyState();
  }
}

// ============================================================
// Init
// ============================================================

setupConnectionPopover();
watchEmptyState();

window._uxPolish = {
  toggleConnectionPopover,
  enhanceEmptyState,
};
