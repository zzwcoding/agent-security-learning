# 起步 Agent 镜像:Python 3.12 slim + 全量锁定依赖
# 密钥不进镜像——运行时通过 -e 环境变量注入(见 scripts/docker-run.sh)
FROM python:3.12-slim

WORKDIR /app

# 先拷锁文件再装依赖:依赖不变时这层走缓存,重建秒回
COPY requirements-lock.txt .
RUN pip install --no-cache-dir -r requirements-lock.txt

# 再拷代码(agent.py / config.py / mcp_servers/ / workspace/ 里的 notes.txt 和假 .env)
COPY . .

# MCP server 由 agent 在同一容器内拉成子进程(stdio),无需额外端口
CMD ["python", "agent.py"]
