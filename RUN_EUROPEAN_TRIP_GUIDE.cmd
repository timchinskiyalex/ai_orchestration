@echo off
setlocal
cd /d "%~dp0"

git push -u origin pilot/european-trip-guide
if errorlevel 1 (
  echo.
  echo Initial pilot branch push failed. Autonomous delivery was not started.
  exit /b 1
)

call "%~dp0START_DEVELOPMENT.cmd"
exit /b %errorlevel%
