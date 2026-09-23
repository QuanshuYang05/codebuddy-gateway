@echo off
cd /d "%~dp0"

uv --version >nul 2>nul
if errorlevel 1 (
  echo [ERROR] uv not found in PATH.
  echo Install it first, then run this again.
  pause
  exit /b 1
)

echo Starting workbuddy2api on http://127.0.0.1:8787
echo Keep this window open while using Claude Code / CC-Switch.
echo.
uv run python -m core.converter --desensitize --log converter.log
pause
