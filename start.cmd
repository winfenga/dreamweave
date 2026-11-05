@echo off
setlocal
title DreamWeave 启动器
cd /d "%~dp0"

echo ============================================
echo   DreamWeave  启动器
echo ============================================
echo.

REM 优先用已构建产物直接启动（最快，日常使用用这个）
if exist "node_modules\electron\dist\electron.exe" (
  if exist "out\main\index.js" (
    echo [1/1] 使用已构建版本启动...
    echo.
    echo   数据目录: %~dp0DreamWeave-data
    echo.
    echo   窗口关闭即退出；如需开发者模式请运行 start-dev.cmd
    echo.
    start "" "node_modules\electron\dist\electron.exe" .
    exit /b 0
  )
)

echo 未找到构建产物，先构建一次...
call npm run build
if errorlevel 1 (
  echo.
  echo [错误] 构建失败，请检查上面的报错。
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
