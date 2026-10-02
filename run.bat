@echo off
chcp 65001 >nul
title KohKae Status (8090)
cd /d "%~dp0"

rem ---- ต้องมี Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [X] ไม่พบ Node.js ในเครื่องนี้ - ติดตั้งจาก https://nodejs.org ก่อน
  pause
  exit /b 1
)

rem ---- อ่านพอร์ตจาก .env (ไม่มี = 8090) ----
set "PORT=8090"
if exist ".env" for /f "tokens=1,* delims==" %%a in ('findstr /b /i "STATUS_PORT=" ".env"') do if not "%%b"=="" set "PORT=%%b"
title KohKae Status (%PORT%)

rem ---- ปิดตัวเก่าที่ค้างอยู่บนพอร์ตนี้ (ถ้ามี) ----
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do taskkill /PID %%p /F >nul 2>nul

rem ---- เปิดหน้าเว็บให้เองหลังเซิร์ฟเวอร์ขึ้น (ครั้งแรกครั้งเดียว) ----
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:%PORT%"

echo หน้าสถานะ: http://localhost:%PORT%
echo ปิดหน้าต่างนี้ = ปิดหน้าสถานะ
echo.

rem ---- วนเปิดใหม่เองถ้าเซิร์ฟเวอร์ปิดตัว (เช่น กด "เปิดหน้าสถานะใหม่" ในหน้าตั้งค่า) ----
:loop
node status_server.js
echo.
echo [%time%] เซิร์ฟเวอร์ปิดตัว (รหัส %errorlevel%) - จะเปิดใหม่ใน 3 วินาที  ^(กด Ctrl+C เพื่อหยุด^)
timeout /t 3 /nobreak >nul
goto loop
