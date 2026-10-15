@echo off
rem Builds KeyBlocker.exe with the C# compiler that ships with Windows (no installs needed).
setlocal
cd /d "%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [ERROR] .NET Framework 4 C# compiler not found.
  pause
  exit /b 1
)
"%CSC%" /nologo /target:winexe /optimize+ /platform:anycpu /out:KeyBlocker.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll KeyBlocker.cs
if errorlevel 1 (
  echo [ERROR] build failed
  pause
  exit /b 1
)
echo Built %~dp0KeyBlocker.exe
