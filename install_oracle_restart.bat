@echo off
REM คลิกขวาไฟล์นี้ แล้วเลือก Run as administrator (ทำครั้งเดียว)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_oracle_restart.ps1"
echo.
pause
