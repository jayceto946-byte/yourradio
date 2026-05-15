@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-local-radio.ps1" %*
