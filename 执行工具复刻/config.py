"""集中放可调常量,后续阶段的 MCP 配置也会加在这里。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).parent

# filesystem 工具的根目录:Agent 读写文件被限制在这个目录里
WORKSPACE_DIR = BASE_DIR / "workspace"

# 对话历史持久化文件(运行时生成,已 gitignore)
MEMORY_FILE = BASE_DIR / "memory.json"

# LLM 接入三要素:OpenAI 兼容协议下,换供应商只改这三个环境变量
# key 从 Keychain 注入(见 scripts/run-with-keychain.sh),不写进任何文件
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "")
