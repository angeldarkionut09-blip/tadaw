@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
  echo Git nu este instalat sau nu este in PATH.
  echo Instaleaza Git for Windows, apoi redeschide acest fisier.
  pause
  exit /b 1
)

echo NICUBANK - incarcare cod in depozitul GitHub privat
echo Creeaza mai intai un depozit privat gol pe GitHub, fara README, licenta sau .gitignore.
echo.

if not exist ".git" (
  git init
  if errorlevel 1 goto :failed
)

git branch -M main
if errorlevel 1 goto :failed

set "CURRENT_REMOTE="
git remote get-url origin >nul 2>&1
if not errorlevel 1 for /f "delims=" %%U in ('git remote get-url origin') do set "CURRENT_REMOTE=%%U"
if defined CURRENT_REMOTE echo Depozitul configurat acum: %CURRENT_REMOTE%
set /p "REMOTE_URL=Lipeste adresa HTTPS GitHub pentru depozitul dorit (Enter pastreaza adresa existenta): "
if not defined REMOTE_URL if not defined CURRENT_REMOTE (
  echo Nu ai introdus o adresa GitHub.
  pause
  exit /b 1
)
if not defined REMOTE_URL set "REMOTE_URL=%CURRENT_REMOTE%"

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin "%REMOTE_URL%"
) else (
  git remote set-url origin "%REMOTE_URL%"
)
if errorlevel 1 goto :failed
echo Codul va fi trimis la: %REMOTE_URL%

:stage_files
git add -A
if errorlevel 1 goto :failed

echo.
echo Acestea sunt fisierele pregatite pentru incarcare:
git status --short
echo.
echo Fisierele locale .env, baza de date, documentele incarcate si node_modules sunt ignorate prin .gitignore.
choice /c DA /n /m "Continui cu commit si incarcare pe GitHub? (D/A) "
if errorlevel 2 goto :cancelled

git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Prepare NICUBANK deployment"
  if errorlevel 1 goto :failed
) else (
  echo Nu exista modificari noi de salvat.
)

git push -u origin main
if errorlevel 1 goto :failed

echo.
echo Codul a fost incarcat. Urmatorul pas: conecteaza depozitul in Render si creeaza serviciul din render.yaml.
pause
exit /b 0

:cancelled
echo Incarcarea a fost anulata. Nu s-a trimis nimic pe GitHub.
pause
exit /b 0

:failed
echo.
echo Operatia s-a oprit cu eroare. Citeste mesajul Git de mai sus si incearca din nou.
echo Daca Git cere autentificare, conecteaza-te in fereastra deschisa de Git Credential Manager.
pause
exit /b 1
