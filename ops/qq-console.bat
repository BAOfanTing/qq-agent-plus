@echo off
chcp 65001 >nul
title QQ Agent 控制台 - SSH 隧道
setlocal
rem ============================================================================
rem  QQ Agent 控制台一键打开（Windows 客户端侧）
rem
rem  用途：本机建立 SSH 隧道把服务器上的控制台/WebUI/远程桌面映射到 127.0.0.1，
rem        等控制台就绪后自动用浏览器打开（带 token 时免输口令）。
rem  用法：
rem    set QQ_AGENT_SSH=user@your-server
rem    set QQ_AGENT_CONSOLE_TOKEN=xxxx        （可省略，省略则打开后手动登录）
rem    qq-console.bat
rem    qq-console.bat test                    （自检模式：只等就绪，不开浏览器）
rem  可选环境变量（默认值见括号）：
rem    QQ_AGENT_SSH            必填，形如 user@host
rem    QQ_AGENT_CONSOLE_TOKEN  控制台 token，可省略
rem    QQ_AGENT_CONSOLE_PORT   控制台端口（3210）
rem    QQ_AGENT_WEBUI_PORT     SnowLuma WebUI 端口（5099）
rem    QQ_AGENT_VNC_PORT       远程桌面/扫码端口（6081）
rem  前置条件：本机已配置到服务器的 SSH 免密登录（密钥），且服务器上服务在跑。
rem ============================================================================

if not defined QQ_AGENT_SSH (
  echo 请先设置服务器地址，例如：
  echo     set QQ_AGENT_SSH=user@your-server
  exit /b 1
)
if not defined QQ_AGENT_CONSOLE_PORT set "QQ_AGENT_CONSOLE_PORT=3210"
if not defined QQ_AGENT_WEBUI_PORT set "QQ_AGENT_WEBUI_PORT=5099"
if not defined QQ_AGENT_VNC_PORT set "QQ_AGENT_VNC_PORT=6081"

set "SRV=%QQ_AGENT_SSH%"
set "CPORT=%QQ_AGENT_CONSOLE_PORT%"
set "WPORT=%QQ_AGENT_WEBUI_PORT%"
set "VPORT=%QQ_AGENT_VNC_PORT%"
if defined QQ_AGENT_CONSOLE_TOKEN (
  set "URL=http://127.0.0.1:%CPORT%/?token=%QQ_AGENT_CONSOLE_TOKEN%"
) else (
  set "URL=http://127.0.0.1:%CPORT%/"
)

echo ============================================================
echo   QQ Agent 控制台（通过 SSH 隧道访问 %SRV%）
echo ============================================================
echo.
echo 正在建立 SSH 隧道（需已配置密钥登录）...
echo 就绪后会自动打开控制台；若已设置 QQ_AGENT_CONSOLE_TOKEN 则免输令牌。
echo.
echo    QQ Agent 控制台 ....... http://127.0.0.1:%CPORT%
echo    SnowLuma WebUI ........ http://127.0.0.1:%WPORT%
echo    QQ 远程桌面 / 扫码 .... http://127.0.0.1:%VPORT%
echo.
echo 关闭本窗口 = 断开隧道；服务器上的机器人照常运行。
echo 若浏览器没自动打开，把下面这行整条粘进地址栏：
echo   %URL%
echo ============================================================
echo.

rem ── 隧道放在后台（同一个窗口），控制台窗口本身负责等待就绪 ──
start /b ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=15 -o ExitOnForwardFailure=yes -L %CPORT%:127.0.0.1:%CPORT% -L %WPORT%:127.0.0.1:%WPORT% -L %VPORT%:127.0.0.1:%VPORT% %SRV%

where curl >nul 2>&1
if errorlevel 1 goto nocurl

echo 等待控制台就绪（最多 45 秒）...
set /a tries=0
:waitloop
set /a tries+=1
curl -s -o nul --max-time 2 "%URL%" >nul 2>&1
if not errorlevel 1 goto ready
if %tries% geq 45 goto stalled
timeout /t 1 >nul
goto waitloop

:ready
echo 隧道就绪（用了 %tries% 秒）。
if /i "%~1"=="test" goto testdone
start "" "%URL%"
echo.
echo 控制台已打开。关掉本窗口即断开隧道。
pause >nul
exit /b 0

:nocurl
echo （本机没有 curl，改用固定等待 8 秒）
timeout /t 8 >nul
if /i "%~1"=="test" goto testdone
start "" "%URL%"
echo.
echo 控制台已打开。关掉本窗口即断开隧道。
pause >nul
exit /b 0

:stalled
echo.
echo ！！45 秒内没能连上控制台。
echo    可能原因：网络不通 / SSH 密钥失效 / 服务器上的控制台没在跑。
echo    你可以在另一个窗口手动试：ssh %SRV%
if /i "%~1"=="test" exit /b 1
pause >nul
exit /b 1

:testdone
echo TEST_OK: 隧道与控制台均就绪（测试模式，未打开浏览器）
exit /b 0
