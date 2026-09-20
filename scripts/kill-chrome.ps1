# Kills only the Chrome processes this app itself launched for browser
# automation (identified by their own command line pointing at this
# project's data\ directory — the persistent pipeline profile, or a
# throwaway llAdGate.js/oiilaGate.js isolated-resolver profile) — never a
# blanket "kill every chrome.exe", which would also close the operator's
# own regular browsing Chrome. Invoked by scripts/kill-chrome.js.
param(
  [Parameter(Mandatory = $true)][string]$Marker
)

$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Marker) }

if (-not $procs) {
  Write-Host "[kill-chrome] No automation Chrome windows found."
  exit 0
}

foreach ($p in $procs) {
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    Write-Host "[kill-chrome] Killed chrome.exe PID $($p.ProcessId)"
  } catch {
    Write-Warning "[kill-chrome] Failed to kill PID $($p.ProcessId): $_"
  }
}
