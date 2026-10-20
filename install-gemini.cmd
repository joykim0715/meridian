@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js가 없다. https://nodejs.org 에서 설치한 뒤 다시 실행한다.
  exit /b 1
)
where python >nul 2>&1
if errorlevel 1 (
  echo Python이 없다. PATH에 python이 있게 설치한 뒤 다시 실행한다.
  exit /b 1
)
if not exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" if not exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
  echo Microsoft Edge를 찾지 못했다.
  exit /b 1
)
call npm install
if errorlevel 1 exit /b 1
if not exist ".env" copy /Y ".env.example" ".env" >nul
echo.
echo 설치가 끝났다. .env 의 GEMINI_API_KEY 를 채운 뒤 run-daily-gemini.cmd 를 한 번 실행한다.
echo 매일 등록은 runtime\register-task-gemini.ps1 이다. 이 설치는 예약을 만들지 않는다.
exit /b 0
