@echo off
setlocal
chcp 65001 >nul 2>&1
title JSON and Log Studio
cd /d "%~dp0"

if not exist "app.py" goto :noapp

rem ---- 优先使用随包携带的 Python 运行时（目标电脑无需安装 Python）----
set "PYEXE="
set "PYFROM="
if exist "%~dp0runtime\python\python.exe" (
  set "PYEXE=%~dp0runtime\python\python.exe"
  set "PYFROM=内置运行时"
)
if defined PYEXE goto :run

rem ---- 没有内置运行时，退回系统 Python ----
where py >nul 2>nul
if not errorlevel 1 (
  set "PYEXE=py"
  set "PYFROM=系统 py 启动器"
)
if defined PYEXE goto :run

where python >nul 2>nul
if not errorlevel 1 (
  set "PYEXE=python"
  set "PYFROM=系统 python"
)
if defined PYEXE goto :run

where python3 >nul 2>nul
if not errorlevel 1 (
  set "PYEXE=python3"
  set "PYFROM=系统 python3"
)
if defined PYEXE goto :run

goto :nopython

:run
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
echo.
echo   JSON ^& 日志工作台 正在启动...
echo   运行时 : %PYFROM%
echo   命令   : %PYEXE%
echo   目录   : %CD%
echo   提示   : 关闭本窗口即停止服务
echo.
"%PYEXE%" "%~dp0app.py" %*
set "EXITCODE=%errorlevel%"
echo.
echo   [已停止] 退出码 %EXITCODE%
echo   如果浏览器没有自动打开，请手动复制上面打印的“访问地址”。
echo.
pause
exit /b %EXITCODE%

:noapp
echo.
echo   [错误] 在当前目录找不到 app.py
echo   当前目录: %CD%
echo   请确认 启动工作台.bat 与 app.py 在同一个文件夹里。
echo.
pause
exit /b 1

:nopython
echo.
echo   [错误] 既没有内置运行时，也没有找到系统 Python
echo.
echo   正常情况下 studio\runtime\python\python.exe 应该存在。
echo   如果你只拷贝了部分文件，请把整个 studio 文件夹完整复制过来；
echo   或者在本机安装 Python 3.8+ 后重试（安装时勾选 Add python.exe to PATH）：
echo   https://www.python.org/downloads/windows/
echo.
pause
exit /b 1
