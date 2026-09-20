import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Closes any Chrome window this app itself spawned for automation — the
 * main pipeline's persistent profile (data/browser-profile) or a
 * throwaway isolated-resolver profile (data/llgate-run-*,
 * data/oiilagate-run-*) — before start (a stale chrome.exe from a prior
 * crash still holding one of these profile directories open makes the
 * next launchPersistentContext() fail outright, since Chrome refuses to
 * open a user-data-dir another running instance already has locked) and
 * when stopping everything explicitly. Delegates the actual process
 * matching to kill-chrome.ps1 — PowerShell's own CIM query can read a
 * process's command line without the quoting headaches of building that
 * query as a string passed through cmd.exe first.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const dataDirMarker = path.join(projectRoot, 'data') + path.sep;

function main() {
  if (os.platform() !== 'win32') {
    console.log('[kill-chrome] Not on Windows — skipping (no automation Chrome cleanup needed on this platform).');
    return;
  }
  const psScript = path.join(__dirname, 'kill-chrome.ps1');
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-Marker', dataDirMarker],
      { stdio: 'inherit' },
    );
  } catch (err) {
    console.warn(`[kill-chrome] Skipping (couldn't run cleanup): ${err.message}`);
  }
}

main();
