@echo off
setlocal
cd /d "%~dp0"

echo Reinstalez dependintele din lockfile pentru Windows...
echo Acest pas regenereaza si comenzile .cmd pentru modulele native.
call npm ci --include=optional
if errorlevel 1 goto :failed

echo Verific modulul SQLite...
node -e "const DB=require('better-sqlite3'); const db=new DB(':memory:'); console.log(db.prepare('select 1 as ok').get())"
if errorlevel 1 goto :failed

echo.
echo Repararea a reusit. Acum poti rula start-nicubank.cmd.
pause
exit /b 0

:failed
echo.
echo Repararea a esuat. Copiaza eroarea de mai sus.
pause
exit /b 1
