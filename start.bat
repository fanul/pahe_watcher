@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  pahe-watcher - starting
echo ============================================

rem Clean up any automation Chrome window left over from a prior crash
rem first -- a stale one still holding data\browser-profile open makes the
rem server's own browser launch fail outright.
node scripts\kill-chrome.js

rem npm start already frees the configured port (see package.json's
rem "prestart" -> scripts\kill-port.js) before launching the server.
call npm start

echo.
echo pahe-watcher has stopped.
pause
