@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  pahe-watcher - stopping all sessions
echo ============================================

rem Kills whatever's listening on the configured port (the running server).
node scripts\kill-port.js

rem Closes any automation Chrome windows the server spawned (main pipeline
rem or isolated-resolver profiles) -- never the operator's own Chrome, see
rem kill-chrome.ps1 for how it tells the two apart.
node scripts\kill-chrome.js

echo.
echo Done.
pause
