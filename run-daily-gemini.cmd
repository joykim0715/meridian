@echo off
setlocal
cd /d "%~dp0"
set "SBHNEWS_WRITER=gemini"
set "FROM_SCHEDULER="
if /I "%~1"=="--from-scheduler" set "FROM_SCHEDULER=1"
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0src\run-daily.mjs"
set "EC=%ERRORLEVEL%"
if "%EC%"=="4" if defined FROM_SCHEDULER exit /b 0
exit /b %EC%
