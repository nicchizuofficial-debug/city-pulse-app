@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PY39=C:\Users\matsumoto1472\AppData\Local\Programs\Python\Python39\python.exe

if not exist "data\transit_pulse.json" (
    echo [City Pulse] 初回起動: 24時間分の運行データを生成しています...
    "%PY39%" pipeline\build_pulse_data.py
)

echo [City Pulse] サーバーを起動しています... http://127.0.0.1:8600
start "" "http://127.0.0.1:8600"
"%PY39%" server.py
