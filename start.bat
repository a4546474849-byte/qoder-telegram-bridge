@echo off
rem Qoder CLI — Telegram Bridge Auto-Start
rem IMPORTANT: Must run from C:\Qoder_CLI so qodercli finds .qoder directory

cd /d C:\Qoder_CLI

:restart
echo [%date% %time%] Starting Qoder Telegram Bridge...
call C:\Qoder_CLI\run-bridge.cmd

echo [%date% %time%] Bridge crashed! Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto restart
