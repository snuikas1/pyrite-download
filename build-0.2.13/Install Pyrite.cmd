@echo off
rem Pyrite trial: runs the installer in Windows PowerShell 5.1, which every Windows 10 and 11 has,
rem then keeps this window open so its last lines can be read.
if not exist "%~dp0bridge\install-windows.ps1" (
  echo FAIL This file ran without its folder. Extract the whole zip first: right-click it, Extract All.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bridge\install-windows.ps1" %*
echo.
pause
