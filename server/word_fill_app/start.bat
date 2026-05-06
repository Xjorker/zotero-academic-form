# Word填表服务启动脚本
# 双击运行此脚本启动服务

@echo off
echo 启动Word填表服务...
cd /d "%~dp0"
echo 当前目录: %CD%
python -m uvicorn main:app --host 0.0.0.0 --port 8000
pause
