@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 18 or newer from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
if not exist node_modules\express\package.json (
  echo Installing required packages. Internet connection is required for first setup...
  call npm install
  if errorlevel 1 (
    echo Package installation failed. Check internet connection and npm error above.
    pause
    exit /b 1
  )
)
if not exist node_modules\dotenv\package.json (
  echo Installing missing dotenv package...
  call npm install
  if errorlevel 1 (
    echo Package installation failed. Check npm error above.
    pause
    exit /b 1
  )
)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example. Add your Upstox token to .env before using live data.
)
echo Starting AJS TRADING PRO...
call npm start
pause
