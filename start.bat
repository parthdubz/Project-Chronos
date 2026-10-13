@echo off
setlocal
title PROJECT CHRONOS Launcher
rem ---------------------------------------------------------------------------
rem PROJECT CHRONOS launcher - runs on any Windows PC.
rem
rem  * Builds the frontend once so the backend serves EVERYTHING from one address
rem    (no localhost / port numbers baked into the app).
rem  * Starts the backend on 0.0.0.0, so other PCs on the same network can open it.
rem  * The backend creates the database and loads the Round 1 items on first start.
rem
rem Usage:  start.bat            (port 8000)
rem         start.bat 8080       (custom port)
rem Set NO_BROWSER=1 to skip opening the browser.
rem ---------------------------------------------------------------------------
set "ROOT=%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

rem ---- Python (a real interpreter, not the Microsoft Store shortcut) ----
set "PY="
python -c "import sys" >nul 2>nul && set "PY=python"
if not defined PY (
  py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
)
if not defined PY (
  echo [ERROR] Python 3.10+ was not found. Install it from https://www.python.org/downloads/
  echo         and tick "Add python.exe to PATH" during setup.
  pause
  exit /b 1
)

rem ---- Port must be free ----
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [ERROR] Port %PORT% is already in use ^(a backend may already be running^).
  echo         Close it, or run:  start.bat 8080
  pause
  exit /b 1
)

rem ---- Backend packages (first run only) ----
%PY% -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
  echo Installing backend packages ^(internet needed the first time^)...
  %PY% -m pip install -r "%ROOT%backend\requirements.txt"
  if errorlevel 1 (
    echo [ERROR] Could not install the backend packages.
    pause
    exit /b 1
  )
)

rem ---- Frontend: build it so the backend can serve it (needs Node.js) ----
set "HAVE_NODE=0"
where npm >nul 2>nul
if not errorlevel 1 set "HAVE_NODE=1"

if "%HAVE_NODE%"=="1" (
  if not exist "%ROOT%frontend\node_modules" (
    echo Installing frontend packages ^(internet needed the first time^)...
    pushd "%ROOT%frontend"
    call npm install
    popd
  )
  echo Building the frontend...
  rem "/" = same origin: the app calls whatever address it was opened from.
  set "VITE_API_BASE=/"
  pushd "%ROOT%frontend"
  call npm run build
  if errorlevel 1 set "BUILD_FAILED=1"
  popd
  if defined BUILD_FAILED echo [WARNING] Frontend build failed - using the previous build if there is one.
) else (
  echo [NOTE] Node.js not found - using the existing frontend build.
)

if not exist "%ROOT%frontend\dist\index.html" (
  echo [ERROR] No frontend build found. Install Node.js from https://nodejs.org and run this again.
  pause
  exit /b 1
)

rem ---- Allow other PCs through the Windows firewall (only works when run as Administrator) ----
netsh advfirewall firewall show rule name="CHRONOS Server" >nul 2>nul
if errorlevel 1 netsh advfirewall firewall add rule name="CHRONOS Server" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>nul

echo.
echo Starting CHRONOS on port %PORT% ...
start "CHRONOS Server" /D "%ROOT%backend" cmd /k %PY% -m uvicorn app.main:app --host 0.0.0.0 --port %PORT%

echo.
echo ================================================================
echo  CHRONOS is starting.
echo.
echo  On this PC:               http://127.0.0.1:%PORT%/
echo  Other PCs ^(same network^), open one of:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do echo      http://%%b:%PORT%/
)
echo.
echo  If another PC cannot connect: click "Allow access" if Windows asks, or
echo  run this file once as Administrator ^(it opens the firewall port^).
echo  To stop: close the "CHRONOS Server" window.
echo ================================================================

if not defined NO_BROWSER (
  timeout /t 4 /nobreak >nul
  start "" "http://127.0.0.1:%PORT%/"
)
endlocal
