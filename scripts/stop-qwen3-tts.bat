@echo off
setlocal
cd /d "%~dp0.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-qwen3-tts.ps1" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo Failed to stop Qwen3 TTS. Exit code: %EXITCODE%
  pause
)
exit /b %EXITCODE%
