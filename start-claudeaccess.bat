@echo off
setlocal enabledelayedexpansion

REM Adjust these if you changed the server's host/port on the options page
REM (server/config.js's defaults are localhost:1080).
set "HOST=localhost"
set "PORT=1080"
set "URL=http://%HOST%:%PORT%"

cd /d "%~dp0"

echo Installing/checking dependencies...
call npm install
if errorlevel 1 (
	echo npm install failed.
	pause
	exit /b 1
)

echo Starting the ClaudeAccess server...
start "ClaudeAccess Server" cmd /k npm start

echo Waiting for the server to be ready at %URL% ...
set /a TRIES=0

:waitloop
set /a TRIES+=1
curl -s -o nul "%URL%"
if %errorlevel%==0 goto ready
if %TRIES% GEQ 30 (
	echo Timed out waiting for the server - opening the browser anyway.
	goto ready
)
timeout /t 1 /nobreak >nul
goto waitloop

:ready
start "" "%URL%"

endlocal
