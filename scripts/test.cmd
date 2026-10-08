@echo off
rem ============================================================
rem  Run vitest under Electron's own Node.
rem  WHY: node_modules/better-sqlite3 is rebuilt for the Electron
rem  ABI (v130, Electron 33.4.11). Running vitest under the system
rem  Node 22 (ABI 127) fails with NODE_MODULE_VERSION mismatch.
rem  ELECTRON_RUN_AS_NODE=1 turns electron.exe into a plain Node
rem  runtime using Electron's embedded Node 20.18.3 (ABI 130).
rem  NOTE: keep this file pure ASCII (cmd parses in ANSI/GBK).
rem ============================================================
set ELECTRON_RUN_AS_NODE=1
cd /d "%~dp0.."
node_modules\electron\dist\electron.exe node_modules\vitest\vitest.mjs %*
