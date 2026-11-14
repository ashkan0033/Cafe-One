@echo off
setlocal
cd /d "%~dp0.."

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    echo [ERROR] .NET Framework csc.exe compiler was not found.
    exit /b 1
)

echo [1/3] Generating Cafe One Windows icon...
python installer\generate_icon.py
if errorlevel 1 exit /b 1

echo [2/3] Compiling CafeOne.exe (windowless desktop launcher)...
"%CSC%" /nologo /utf8output /codepage:65001 /optimize+ /target:winexe /platform:anycpu /win32icon:assets\cafe-one.ico /out:CafeOne.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll installer\CafeOneLauncher.cs
if errorlevel 1 exit /b 1

echo [3/3] Compiling CafeOne-Installer.exe (GUI setup wizard)...
"%CSC%" /nologo /utf8output /codepage:65001 /optimize+ /target:winexe /platform:anycpu /win32icon:assets\cafe-one.ico /out:CafeOne-Installer.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll installer\CafeOneInstaller.cs
if errorlevel 1 exit /b 1

echo [DONE] Built assets\cafe-one.ico, CafeOne.exe, and CafeOne-Installer.exe
