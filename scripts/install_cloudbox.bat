@echo off
setlocal DisableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "POWERSHELL_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "POWERSHELL_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"

if not exist "%POWERSHELL_EXE%" (
  >&2 echo install_cloudbox: Windows PowerShell 5.1 was not found.
  endlocal & exit /b 1
)
if not exist "%SCRIPT_DIR%install_cloudbox.ps1" (
  >&2 echo install_cloudbox: install_cloudbox.ps1 must be next to this BAT file.
  endlocal & exit /b 1
)

"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install_cloudbox.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
