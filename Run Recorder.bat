@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Run "npm install" first.
  pause
  exit /b 1
)
rem Launch the app detached so no console window lingers with capture logs.
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
exit
