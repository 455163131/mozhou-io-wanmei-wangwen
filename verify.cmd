@echo off
rem ============================================================
rem  AI-flavor calibration - one-click acceptance (9 checks)
rem  Exit code: 0 = all pass, 1 = any fail (CI friendly).
rem  NOTE: keep this file pure ASCII (same reason as dev.cmd).
rem ============================================================
cd /d "%~dp0"
echo [verify] project dir: %cd%
echo.
call node scripts\verify-flavor-acceptance.mjs
echo.
echo [verify] detail report: data\flavor_acceptance_report.md
pause
