@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==================================================
echo   Cafe One - Target PC Setup
echo ==================================================
echo.

set "SYS_PY="
where python >nul 2>nul
if %errorlevel%==0 (
    set "SYS_PY=python"
) else (
    where py >nul 2>nul
    if %errorlevel%==0 set "SYS_PY=py -3"
)

if "%SYS_PY%"=="" (
    echo [ERROR] Python 3.11+ was not found on PATH.
    echo Install Python from https://www.python.org/downloads/ and check "Add Python to PATH".
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo [1/4] Creating virtual environment (.venv)...
    %SYS_PY% -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create .venv.
        pause
        exit /b 1
    )
) else (
    echo [1/4] Existing .venv found. Checking dependencies...
)

echo [2/4] Installing Python dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul 2>nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install packages from requirements.txt.
    pause
    exit /b 1
)

echo [3/4] Generating Prisma database client...
".venv\Scripts\python.exe" -m prisma generate --schema=backend\prisma\schema.prisma
if errorlevel 1 (
    echo [ERROR] Failed to generate Prisma client.
    pause
    exit /b 1
)

if not exist "backend\prisma\database.sqlite" (
    echo [4/4] Initializing SQLite database...
    ".venv\Scripts\python.exe" -m prisma db push --schema=backend\prisma\schema.prisma
    if errorlevel 1 (
        echo [ERROR] Failed to initialize SQLite database.
        pause
        exit /b 1
    )
) else (
    echo [4/4] Existing backend\prisma\database.sqlite preserved.
)

if not exist "frontend\out\index.html" (
    echo [WARN] frontend\out\index.html not found! Ensure the static frontend build is copied or built.
)

echo.
echo [DONE] Setup complete. You can now launch Cafe One using start_cafe_one.bat
pause
