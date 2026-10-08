@echo off
rem ============================================================
rem  Mozhou Agent - one-click dev launcher
rem  Double-click from anywhere; always cds to the project dir.
rem  NOTE: keep this file pure ASCII - cmd.exe parses .bat/.cmd
rem  in the system ANSI codepage, UTF-8 comments break parsing.
rem ============================================================
cd /d "%~dp0"
echo [dev] project dir: %cd%
echo [dev] starting electron-vite dev ...
echo [dev] closing the app window exits this script; screenshot any error.
echo.
call npm run dev
echo.
echo [dev] process exited (code %errorlevel%).
pause
