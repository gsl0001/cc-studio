@echo off
rem cc-studio's runner for Task Scheduler (npm run tasks:install registers the tasks):
rem   cc-studio.cmd tick ^| pulse ^| insights ^| bot ^| desk ^| cc
rem STOP_AUTOMATION (written by "pause") halts the pipeline jobs, here and in node.
cd /d "%~dp0"
if not exist logs mkdir logs
rem The bot, the desk and cc run even while paused: they are how "resume" arrives.
if /i "%~1"=="bot" node scripts\telegram-bot.mjs >> logs\telegram-bot.log 2>&1 & exit /b
if /i "%~1"=="desk" node src\server.js >> logs\desk.log 2>&1 & exit /b
if /i "%~1"=="cc" powershell -NoProfile -STA -ExecutionPolicy Bypass -File scripts\cc.ps1 >> logs\cc.log 2>&1 & exit /b
if exist STOP_AUTOMATION exit /b 0
if /i "%~1"=="tick" node scripts\tick.mjs >> logs\tick.log 2>&1 & exit /b
if /i "%~1"=="pulse" node scripts\pulse.mjs >> logs\pulse.log 2>&1 & exit /b
if /i "%~1"=="insights" node scripts\weekly-insights.mjs >> logs\insights.log 2>&1 & exit /b
echo usage: cc-studio.cmd tick^|pulse^|insights^|bot^|desk^|cc & exit /b 1
