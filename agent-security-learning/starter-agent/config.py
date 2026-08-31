"""集中放可调常量,后续阶段的 MCP 配置也会加在这里。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).parent

# filesystem 工具的根目录:Agent 读写文件被限制在这个目录里
WORKSPACE_DIR = BASE_DIR / "workspace"

# 对话历史持久化文件(运行时生成,已 gitignore)
MEMORY_FILE = BASE_DIR / "memory.json"

# LLM 接入三要素(阶段 26 起):真 key 不进 Agent 进程——base_url 指向本地凭证代理
# (scripts/run-proxy.sh 启动,key 由它从 Keychain 注入转发),本进程只握占位符。
# 默认值兜底意味着:Agent 裸启动也能跑,但手里只有 PLACEHOLDER,没有真密钥。
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://127.0.0.1:5055/v1")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "PLACEHOLDER")
LLM_MODEL = os.environ.get("LLM_MODEL", "MiniMax-M2")
