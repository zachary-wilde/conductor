@echo off
REM Launch Conductor (built app) — double-click or run from explorer.
cd /d "%~dp0"
"%~dp0node_modules\electron\dist\electron.exe" .
