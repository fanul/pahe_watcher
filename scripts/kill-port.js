import { execSync } from 'node:child_process';
import os from 'node:os';

/**
 * Runs as `prestart` (see package.json), before `npm start` launches the
 * real server. Frees the configured port by killing whatever's already
 * listening on it — including a leftover instance of this same app from a
 * prior run that was never cleanly stopped (confirmed live: the recurring
 * annoyance this exists to fix was always exactly that — a previous
 * `node src/index.js` still holding the port from an earlier session).
 * Never throws: if anything here fails, `npm start` should still proceed
 * and let the real server report its own bind error if the port is
 * genuinely still stuck.
 *
 * Bug fixed live: an earlier version resolved the config module path via
 * `path.join(__dirname, ...)` before passing it to a dynamic `import()` —
 * on Windows that produces backslash-separated path, which ESM's import()
 * rejects (it needs a file:// URL or a POSIX-style relative specifier), so
 * the import silently failed on every run and this always fell back to
 * PORT=8787 without ever loading .env (config/index.js is what calls
 * dotenv.config()) instead of the real configured port. A plain relative
 * specifier — `import('../src/config/index.js')` — lets Node's ESM loader
 * resolve it correctly itself, no manual path handling needed.
 */
async function main() {
  let port;
  try {
    const { loadConfig } = await import('../src/config/index.js');
    port = loadConfig().server.port;
  } catch {
    port = Number(process.env.PORT) || 8787;
  }

  try {
    const pids = findListeningPids(port);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        killPid(pid);
        console.log(`[kill-port] Freed port ${port} (killed PID ${pid})`);
      } catch (err) {
        console.warn(`[kill-port] Failed to kill PID ${pid}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[kill-port] Skipping (couldn't inspect port ${port}): ${err.message}`);
  }
}

function findListeningPids(port) {
  const isWindows = os.platform() === 'win32';
  const pids = new Set();

  if (isWindows) {
    const out = safeExec('netstat -ano');
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      // proto, local address, foreign address, state, pid
      if (parts.length < 5) continue;
      const [, localAddr, , state, pid] = parts;
      if (state !== 'LISTENING') continue;
      if (localAddr.split(':').pop() === String(port)) pids.add(pid);
    }
  } else {
    const out = safeExec(`lsof -ti tcp:${port}`);
    for (const pid of out.split('\n').map((s) => s.trim()).filter(Boolean)) pids.add(pid);
  }

  return [...pids];
}

function killPid(pid) {
  if (os.platform() === 'win32') {
    execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
  } else {
    execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
  }
}

/** Returns '' instead of throwing when the lookup command itself finds nothing (its normal, expected exit-nonzero case). */
function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

main();
