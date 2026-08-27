# 起步 Agent 镜像:Python 3.12 slim + 全量锁定依赖
# 密钥不进镜像——运行时通过 -e 环境变量注入(见 scripts/docker-run.sh)
FROM python:3.12-slim

WORKDIR /app

# torch 从官方 CPU 索引装:默认源会拉 CUDA 全家桶(镜像 +4GB),容器里没有 GPU
# 先拷锁文件再装依赖:依赖不变时这层走缓存,重建秒回
COPY requirements-lock.txt .
RUN pip install --no-cache-dir torch==2.13.0 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements-lock.txt

# 非 root 运行:就算 Agent 被注入劫持,攻击者拿到的也只是无权用户(进程边界层)
RUN useradd -m agent && mkdir -p /app/.hf-cache && chown -R agent:agent /app
USER agent
ENV HF_HOME=/app/.hf-cache

# 护栏模型烘进镜像:容器以 --read-only 跑,运行时没法下载;构建期联网下载一次。
# 烘焙放在 COPY 代码之前:模型与代码的变化频率不同,改代码不该重下 1GB 模型
RUN python -c "from llm_guard.input_scanners import PromptInjection; PromptInjection()" \
 && python -c "from llm_guard.output_scanners import Sensitive; Sensitive(entity_types=['CREDIT_CARD','CRYPTO','US_SSN','US_BANK_NUMBER','IBAN_CODE'])"

# 最后拷代码(agent.py / config.py / mcp_servers/ / workspace/ 里的 notes.txt 和假 .env)
COPY . .

# MCP server 由 agent 在同一容器内拉成子进程(stdio),无需额外端口
CMD ["python", "agent.py"]
