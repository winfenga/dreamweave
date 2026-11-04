@echo off
chcp 65001 >nul
title DreamWeave 开发模式
cd /d "%~dp0"

echo ============================================
echo   DreamWeave · 织梦  开发模式
echo ============================================
echo.
echo   改前端代码会自动热更新；改主进程代码会自动重启。
echo   按 Ctrl+C 退出。
echo.

call npm run dev
pause
