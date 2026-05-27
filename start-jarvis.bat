@echo off
echo ========================================
echo    Mimo - AI Assistant
echo ========================================
echo.

echo [1/3] 启动 Mimo 服务器...
start "Mimo Server" /min cmd /c "cd /d %~dp0 && node server.js"
timeout /t 2 /nobreak >nul

echo [2/3] 启动唤醒词检测...
start "Wake Word" cmd /c "cd /d %~dp0 && node wake-word.js"

echo [3/3] 打开浏览器...
timeout /t 2 /nobreak >nul
start http://localhost:3000

echo.
echo ========================================
echo    Mimo 已启动！
echo ========================================
echo.
echo 使用方法：
echo   - 按 Ctrl+Space 激活 Mimo
echo   - 或说 "Mimo" 唤醒（需配置Porcupine）
echo   - 在浏览器中与 Mimo 对话
echo.
echo 按任意键停止所有服务...
pause >nul

echo.
echo 正在停止服务...
taskkill /FI "WindowTitle eq Mimo Server*" /F >nul 2>&1
taskkill /FI "WindowTitle eq Wake Word*" /F >nul 2>&1
echo 已停止。
