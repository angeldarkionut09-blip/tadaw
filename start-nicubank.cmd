@echo off
setlocal
cd /d "%~dp0"

call npm run dev
if errorlevel 1 (
  echo.
  echo NICUBANK s-a oprit cu eroare.
  pause
  exit /b 1
)
