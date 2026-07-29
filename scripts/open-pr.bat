@echo off
REM open-pr.bat - Windows wrapper for open-pr.ps1
REM Double-click this file (from File Explorer) or run from cmd.exe / PowerShell.
REM It will ask for your PAT once, then print the PR URL when done.

setlocal
cd /d "%~dp0\..\"

echo ============================================
echo  auto-explainer-saas - open PR helper
echo ============================================
echo.
echo This will:
echo   1. Ask for your GitHub fine-grained PAT (input hidden)
echo   2. Auth gh CLI
echo   3. Open a PR for branch feat/v0_0_1
echo   4. Print the PR URL
echo.
echo Press any key to continue, or close this window to cancel.
pause >nul

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-pr.ps1"

echo.
echo Script finished. Press any key to close.
pause >nul
endlocal
