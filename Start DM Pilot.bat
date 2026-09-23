@echo off
title DM Pilot
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing for the first time, this takes a minute...
  call npm install || (pause & exit /b 1)
)
node --disable-warning=ExperimentalWarning src/server.js --open
if errorlevel 3 if not errorlevel 4 exit /b 0
echo.
echo DM Pilot has stopped.
pause
