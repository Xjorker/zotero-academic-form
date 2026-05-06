import os
import sys

# 切换到当前目录
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# 启动uvicorn
os.system('python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload')
