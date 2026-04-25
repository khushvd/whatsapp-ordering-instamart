@echo off
REM WhatsApp Ordering (Instamart) - double-click launcher for Windows.
REM Everything runs on your laptop. Nothing is sent anywhere.

cd /d "%~dp0"

echo.
echo ==========================================
echo   WhatsApp Ordering - starting up
echo ==========================================
echo.

REM 1) Check for Node.js.
set NODE_LTS=v22.14.0
set NODE_MSI_URL=https://nodejs.org/dist/%NODE_LTS%/node-%NODE_LTS%-x64.msi
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js is not installed.
  echo Opening the official installer: %NODE_MSI_URL%
  echo Run the .msi, then double-click this file again.
  start "" "%NODE_MSI_URL%"
  echo.
  pause
  exit /b 1
)

REM 2) Install dependencies on first run.
if not exist "node_modules" (
  echo First run - installing dependencies ^(this takes 1-2 minutes^)...
  call npm install
  if %errorlevel% neq 0 (
    echo npm install failed. See the error above.
    pause
    exit /b 1
  )
)

REM 3) Build TypeScript on first run or if dist\ is missing.
if not exist "dist\whatsapp-bot.js" (
  echo Building...
  call npm run build
  if %errorlevel% neq 0 (
    echo Build failed. See the error above.
    pause
    exit /b 1
  )
)

REM 4) Open the browser once the bot writes data\server.port (auto-retry 3000..3004).
REM Uses PowerShell to poll because plain batch + delayed expansion is fiddly.
start "" /B powershell -NoProfile -Command "for ($i=0; $i -lt 12; $i++) { if (Test-Path 'data\server.port') { $p = (Get-Content 'data\server.port' -Raw).Trim(); if ($p) { Start-Process \"http://localhost:$p\"; exit 0 } }; Start-Sleep -Seconds 1 }; Start-Process 'http://localhost:3000'"

echo.
echo Bot is starting. Your browser will open to http://localhost:3000.
echo Keep this window open. To stop the bot, close this window or press Ctrl+C.
echo.

node dist/whatsapp-bot.js
