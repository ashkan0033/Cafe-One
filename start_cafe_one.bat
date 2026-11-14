@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist "frontend\out\index.html" (
    echo [ERROR] frontend\out\index.html not found.
    echo Run the frontend static build or copy frontend\out before launching Cafe One.
    pause
    exit /b 1
)

set "RUN_PY="

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -c "import fastapi, uvicorn, webview, prisma, PIL" >nul 2>nul
    if not errorlevel 1 set "RUN_PY=.venv\Scripts\python.exe"
)

if "%RUN_PY%"=="" (
    python -c "import fastapi, uvicorn, webview, prisma, PIL" >nul 2>nul
    if not errorlevel 1 set "RUN_PY=python"
)

if "%RUN_PY%"=="" (
    echo [ERROR] Required Python packages were not found.
    echo Please run setup_target_pc.bat first.
    pause
    exit /b 1
)

"%RUN_PY%" main.py
if errorlevel 1 (
    echo.
    echo [ERROR] Cafe One exited with an error.
    pause
    exit /b 1
)
