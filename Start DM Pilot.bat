@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing for the first time...
  call npm install || (pause & exit /b 1)
)
node --disable-warning=ExperimentalWarning src/server.js --open
pause
