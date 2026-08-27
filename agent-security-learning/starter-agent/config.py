"""集中放可调常量,后续阶段的 LLM / MCP 配置也会加在这里。"""
from pathlib import Path

BASE_DIR = Path(__file__).parent

# filesystem 工具的根目录:Agent 读写文件被限制在这个目录里
WORKSPACE_DIR = BASE_DIR / "workspace"
