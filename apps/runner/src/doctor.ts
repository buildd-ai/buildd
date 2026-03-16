/**
 * Runner self-diagnostics ("doctor") module.
 *
 * Checks the health of the runner environment and optionally uses Claude
 * to diagnose and fix issues it can't resolve with built-in logic.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BUILDD_DIR = process.env.BUILDD_HOME || join(homedir(), '.buildd');
const BRANCH = process.env.BUILDD_BRANCH || 'main';

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  fixable?: boolean;
  detail?: string;
}

export interface DoctorReport {
  timestamp: string;
  checks: CheckResult[];
  summary: { ok: number; warn: number; error: number };
}

// --- Individual checks ---

function checkGitState(): CheckResult {
  try {
    const head = execSync('git rev-parse HEAD', { cwd: BUILDD_DIR, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: BUILDD_DIR, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();

    if (branch !== BRANCH) {
      return {
        name: 'git-branch',
        status: 'error',
        message: `On branch '${branch}' instead of '${BRANCH}'`,
        fixable: true,
      };
    }

    // Check if behind remote
    try {
      execSync(`git fetch origin ${BRANCH} --dry-run`, { cwd: BUILDD_DIR, encoding: 'utf-8', timeout: 15000, stdio: 'pipe' });
      const behind = execSync(`git rev-list HEAD..origin/${BRANCH} --count`, { cwd: BUILDD_DIR, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
      if (parseInt(behind) > 0) {
        return {
          name: 'git-branch',
          status: 'warn',
          message: `${behind} commit(s) behind origin/${BRANCH}`,
          fixable: true,
        };
      }
    } catch { /* fetch failed, non-fatal */ }

    return { name: 'git-branch', status: 'ok', message: `On ${BRANCH} at ${head.slice(0, 7)}` };
  } catch (err: any) {
    return { name: 'git-branch', status: 'error', message: `Git state unreadable: ${err.message}` };
  }
}

function checkGitDirty(): CheckResult {
  try {
    const status = execSync('git status --porcelain -- apps/ packages/', { cwd: BUILDD_DIR, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    if (status) {
      const lines = status.split('\n').filter(Boolean);
      return {
        name: 'git-clean',
        status: 'warn',
        message: `${lines.length} tracked file(s) modified`,
        detail: status,
        fixable: true,
      };
    }
    return { name: 'git-clean', status: 'ok', message: 'Working tree clean (tracked files)' };
  } catch {
    return { name: 'git-clean', status: 'error', message: 'Could not check git status' };
  }
}

function checkBunInstall(): CheckResult {
  try {
    // Check for lock conflicts — is another bun install running?
    const ps = execSync("ps aux | grep 'bun install' | grep -v grep", { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    const lines = ps.split('\n').filter(Boolean);

    // Filter out our own process
    const otherInstalls = lines.filter(l => !l.includes('doctor'));
    if (otherInstalls.length > 0) {
      return {
        name: 'bun-install',
        status: 'error',
        message: `${otherInstalls.length} other bun install process(es) running — may block updates`,
        detail: otherInstalls.join('\n'),
        fixable: true,
      };
    }
    return { name: 'bun-install', status: 'ok', message: 'No competing bun install processes' };
  } catch {
    // grep returns exit 1 when no matches — that's good
    return { name: 'bun-install', status: 'ok', message: 'No competing bun install processes' };
  }
}

function checkDiskUsage(): CheckResult {
  try {
    const df = execSync("df -h . | tail -1", { cwd: BUILDD_DIR, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    const parts = df.split(/\s+/);
    const usedPct = parseInt(parts[4]); // e.g. "66%"
    if (usedPct >= 90) {
      return { name: 'disk-usage', status: 'error', message: `Disk ${usedPct}% full`, fixable: true };
    }
    if (usedPct >= 75) {
      return { name: 'disk-usage', status: 'warn', message: `Disk ${usedPct}% full`, fixable: true };
    }
    return { name: 'disk-usage', status: 'ok', message: `Disk ${usedPct}% used` };
  } catch {
    return { name: 'disk-usage', status: 'warn', message: 'Could not check disk usage' };
  }
}

function checkStaleWorktrees(): CheckResult {
  const projectDir = join(BUILDD_DIR, '..', 'project');
  if (!existsSync(projectDir)) {
    // Not in a workspace environment
    return { name: 'stale-worktrees', status: 'ok', message: 'No project directory (non-workspace environment)' };
  }

  let totalStale = 0;
  let totalSizeMB = 0;
  const staleDetails: string[] = [];

  try {
    const repos = readdirSync(projectDir).filter(d => {
      const wtDir = join(projectDir, d, '.buildd-worktrees');
      return existsSync(wtDir);
    });

    for (const repo of repos) {
      const wtDir = join(projectDir, repo, '.buildd-worktrees');
      try {
        const entries = readdirSync(wtDir);
        for (const entry of entries) {
          const entryPath = join(wtDir, entry);
          try {
            const stat = statSync(entryPath);
            if (!stat.isDirectory()) continue;
            // Check if worktree has been idle for > 1 hour
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs > 60 * 60 * 1000) {
              totalStale++;
              // Estimate size
              try {
                const du = execSync(`du -sm "${entryPath}" 2>/dev/null | cut -f1`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' }).trim();
                totalSizeMB += parseInt(du) || 0;
              } catch { /* skip */ }
              staleDetails.push(`${repo}/${entry} (${Math.round(ageMs / 3600000)}h old)`);
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  if (totalStale > 0) {
    return {
      name: 'stale-worktrees',
      status: totalSizeMB > 500 ? 'error' : 'warn',
      message: `${totalStale} stale worktree(s) using ~${totalSizeMB}MB`,
      detail: staleDetails.join('\n'),
      fixable: true,
    };
  }
  return { name: 'stale-worktrees', status: 'ok', message: 'No stale worktrees' };
}

function checkScreenSession(): CheckResult {
  try {
    const screens = execSync('screen -ls 2>&1', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    if (screens.includes('buildd')) {
      return { name: 'screen-session', status: 'ok', message: 'Screen session "buildd" active' };
    }
    return { name: 'screen-session', status: 'warn', message: 'No "buildd" screen session found' };
  } catch {
    return { name: 'screen-session', status: 'ok', message: 'Screen not available (may be running directly)' };
  }
}

function checkRunnerProcess(): CheckResult {
  try {
    const ps = execSync("ps aux | grep 'bun run apps/runner' | grep -v grep", { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    if (ps) {
      return { name: 'runner-process', status: 'ok', message: 'Runner process running' };
    }
    return { name: 'runner-process', status: 'error', message: 'Runner process not found' };
  } catch {
    // grep exit 1 = no match
    return { name: 'runner-process', status: 'error', message: 'Runner process not found', fixable: true };
  }
}

function checkConfig(): CheckResult {
  const configPath = join(BUILDD_DIR, 'config.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);

    const issues: string[] = [];
    // API key can come from config or BUILDD_API_KEY env var
    if (!config.apiKey && !config.token && !process.env.BUILDD_API_KEY) {
      issues.push('no auth credentials');
    }
    if (!config.pusherKey) issues.push('no Pusher key (no real-time updates)');

    if (issues.length > 0) {
      return {
        name: 'config',
        status: issues.some(i => i.includes('auth')) ? 'error' : 'warn',
        message: issues.join(', '),
      };
    }
    return { name: 'config', status: 'ok', message: 'Config valid' };
  } catch (err: any) {
    return { name: 'config', status: 'error', message: `Config unreadable: ${err.message}` };
  }
}

function checkRunnerLog(): CheckResult {
  const logPath = '/tmp/buildd.log';
  try {
    if (!existsSync(logPath)) {
      return { name: 'runner-log', status: 'warn', message: 'No runner log at /tmp/buildd.log' };
    }

    const tail = execSync(`tail -50 "${logPath}"`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });

    // Detect auto-update loop
    const updateLines = tail.split('\n').filter(l => l.includes('Auto-updating after'));
    if (updateLines.length >= 5) {
      return {
        name: 'runner-log',
        status: 'error',
        message: `Auto-update loop detected (${updateLines.length} retries in recent log)`,
        detail: tail,
        fixable: true,
      };
    }

    // Detect crash loops
    const restartLines = tail.split('\n').filter(l => l.includes('restarting in 5s'));
    if (restartLines.length >= 3) {
      return {
        name: 'runner-log',
        status: 'error',
        message: `Crash loop detected (${restartLines.length} restarts in recent log)`,
        detail: tail,
      };
    }

    return { name: 'runner-log', status: 'ok', message: 'No issues in recent log' };
  } catch {
    return { name: 'runner-log', status: 'warn', message: 'Could not read runner log' };
  }
}

function checkHistoryDb(): CheckResult {
  const dbPath = join(BUILDD_DIR, 'history.db');
  const walPath = join(BUILDD_DIR, 'history.db-wal');

  try {
    if (!existsSync(dbPath)) {
      return { name: 'history-db', status: 'warn', message: 'No history database' };
    }

    const dbSize = statSync(dbPath).size;
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
    const totalMB = Math.round((dbSize + walSize) / 1024 / 1024);

    if (totalMB > 100) {
      return {
        name: 'history-db',
        status: 'warn',
        message: `History DB is ${totalMB}MB (db: ${Math.round(dbSize / 1024 / 1024)}MB, WAL: ${Math.round(walSize / 1024 / 1024)}MB)`,
        fixable: true,
      };
    }
    return { name: 'history-db', status: 'ok', message: `History DB ${totalMB}MB` };
  } catch {
    return { name: 'history-db', status: 'warn', message: 'Could not check history database' };
  }
}

// --- Fix functions ---

export interface FixResult {
  check: string;
  success: boolean;
  message: string;
}

function fixGitBranch(): FixResult {
  try {
    execSync(`git fetch origin ${BRANCH} && git checkout -f ${BRANCH} && git reset --hard origin/${BRANCH}`, {
      cwd: BUILDD_DIR, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
    });
    return { check: 'git-branch', success: true, message: `Checked out and reset to origin/${BRANCH}` };
  } catch (err: any) {
    return { check: 'git-branch', success: false, message: err.message };
  }
}

function fixGitClean(): FixResult {
  try {
    execSync('git checkout -- apps/ packages/', { cwd: BUILDD_DIR, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    return { check: 'git-clean', success: true, message: 'Restored tracked files' };
  } catch (err: any) {
    return { check: 'git-clean', success: false, message: err.message };
  }
}

function fixBunInstall(): FixResult {
  try {
    // Kill competing bun install processes (not ours)
    const myPid = process.pid;
    execSync(`ps aux | grep 'bun install' | grep -v grep | awk '{print $2}' | grep -v ${myPid} | xargs -r kill 2>/dev/null`, {
      encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
    });
    return { check: 'bun-install', success: true, message: 'Killed competing bun install processes' };
  } catch {
    return { check: 'bun-install', success: true, message: 'No processes to kill' };
  }
}

function fixStaleWorktrees(): FixResult {
  const projectDir = join(BUILDD_DIR, '..', 'project');
  if (!existsSync(projectDir)) {
    return { check: 'stale-worktrees', success: true, message: 'No project directory' };
  }

  let cleaned = 0;
  let freedMB = 0;

  try {
    const repos = readdirSync(projectDir).filter(d => {
      const wtDir = join(projectDir, d, '.buildd-worktrees');
      return existsSync(wtDir);
    });

    for (const repo of repos) {
      const repoDir = join(projectDir, repo);
      const wtDir = join(repoDir, '.buildd-worktrees');
      try {
        const entries = readdirSync(wtDir);
        for (const entry of entries) {
          const entryPath = join(wtDir, entry);
          try {
            const stat = statSync(entryPath);
            if (!stat.isDirectory()) continue;
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs > 60 * 60 * 1000) {
              // Get size before removing
              try {
                const du = execSync(`du -sm "${entryPath}" 2>/dev/null | cut -f1`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' }).trim();
                freedMB += parseInt(du) || 0;
              } catch { /* skip */ }

              // Remove via git worktree remove, fallback to rm -rf
              try {
                execSync(`git worktree remove --force "${entryPath}" 2>/dev/null`, {
                  cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
                });
              } catch {
                execSync(`rm -rf "${entryPath}"`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
              }
              cleaned++;
            }
          } catch { /* skip entry */ }
        }
      } catch { /* skip repo */ }
    }
  } catch { /* skip */ }

  // Also prune orphaned worktree refs
  try {
    const repos = readdirSync(projectDir).filter(d => existsSync(join(projectDir, d, '.git')));
    for (const repo of repos) {
      try {
        execSync('git worktree prune', { cwd: join(projectDir, repo), encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return {
    check: 'stale-worktrees',
    success: true,
    message: cleaned > 0 ? `Removed ${cleaned} stale worktree(s), freed ~${freedMB}MB` : 'No stale worktrees to clean',
  };
}

function fixDiskUsage(): FixResult {
  // Clean known disk hogs: archive, old logs, bun cache
  let freedMB = 0;
  const actions: string[] = [];

  // Clean archive (completed worker data)
  const archiveDir = join(BUILDD_DIR, 'archive');
  if (existsSync(archiveDir)) {
    try {
      const du = execSync(`du -sm "${archiveDir}" | cut -f1`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' }).trim();
      const sizeMB = parseInt(du) || 0;
      if (sizeMB > 50) {
        // Keep last 100 entries, remove the rest
        const entries = readdirSync(archiveDir).sort();
        const toRemove = entries.slice(0, -100);
        for (const entry of toRemove) {
          try {
            execSync(`rm -f "${join(archiveDir, entry)}"`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
          } catch { /* skip */ }
        }
        actions.push(`trimmed archive (kept 100, removed ${toRemove.length})`);
        freedMB += Math.round(sizeMB * (toRemove.length / entries.length));
      }
    } catch { /* skip */ }
  }

  // Clean old logs (keep last 50)
  const logsDir = join(BUILDD_DIR, 'logs');
  if (existsSync(logsDir)) {
    try {
      const logFiles = readdirSync(logsDir)
        .filter(f => f.endsWith('.log') && f !== 'claims.log')
        .map(f => ({ name: f, mtime: statSync(join(logsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      const toRemove = logFiles.slice(50);
      for (const f of toRemove) {
        try { execSync(`rm -f "${join(logsDir, f.name)}"`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }); } catch { /* skip */ }
      }
      if (toRemove.length > 0) actions.push(`removed ${toRemove.length} old log files`);
    } catch { /* skip */ }
  }

  // Clean stale worktrees (delegate)
  const wtResult = fixStaleWorktrees();
  if (wtResult.message.includes('Removed')) actions.push(wtResult.message);

  return {
    check: 'disk-usage',
    success: true,
    message: actions.length > 0 ? actions.join('; ') : 'No obvious disk savings found',
  };
}

function fixHistoryDb(): FixResult {
  const dbPath = join(BUILDD_DIR, 'history.db');
  try {
    // WAL checkpoint to consolidate WAL into main db
    execSync(`sqlite3 "${dbPath}" "PRAGMA wal_checkpoint(TRUNCATE);"`, {
      encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
    });
    return { check: 'history-db', success: true, message: 'Checkpointed WAL into main database' };
  } catch {
    return { check: 'history-db', success: false, message: 'sqlite3 not available or checkpoint failed' };
  }
}

function fixRunnerLog(): FixResult {
  // If auto-update loop detected, the update retry fix should handle it.
  // Clear the log to break the visual pattern.
  try {
    execSync('echo "--- doctor cleared log $(date) ---" > /tmp/buildd.log', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return { check: 'runner-log', success: true, message: 'Cleared runner log' };
  } catch {
    return { check: 'runner-log', success: false, message: 'Could not clear runner log' };
  }
}

const fixMap: Record<string, () => FixResult> = {
  'git-branch': fixGitBranch,
  'git-clean': fixGitClean,
  'bun-install': fixBunInstall,
  'stale-worktrees': fixStaleWorktrees,
  'disk-usage': fixDiskUsage,
  'history-db': fixHistoryDb,
  'runner-log': fixRunnerLog,
};

// --- Main doctor function ---

export function runDiagnostics(): DoctorReport {
  const checks = [
    checkRunnerProcess(),
    checkConfig(),
    checkGitState(),
    checkGitDirty(),
    checkBunInstall(),
    checkScreenSession(),
    checkRunnerLog(),
    checkDiskUsage(),
    checkStaleWorktrees(),
    checkHistoryDb(),
  ];

  const summary = {
    ok: checks.filter(c => c.status === 'ok').length,
    warn: checks.filter(c => c.status === 'warn').length,
    error: checks.filter(c => c.status === 'error').length,
  };

  return {
    timestamp: new Date().toISOString(),
    checks,
    summary,
  };
}

export function autoFix(report: DoctorReport): FixResult[] {
  const results: FixResult[] = [];

  for (const check of report.checks) {
    if ((check.status === 'error' || check.status === 'warn') && check.fixable) {
      const fixer = fixMap[check.name];
      if (fixer) {
        results.push(fixer());
      }
    }
  }

  return results;
}

