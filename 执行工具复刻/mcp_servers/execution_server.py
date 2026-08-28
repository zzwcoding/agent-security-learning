"""执行工具 MCP server:把带闸工具暴露给 agent 的薄壳。

当前阶段(11)注释:安全闸全在 file_tools / execution_tools 里(从项目根 import),
这里只做协议转换——MCP 工具调用 ↔ Python 函数,返回值统一包成 JSON 字符串。
它替换裸奔的 shell_server / filesystem_server(挂载点在 agent.py 的 MCP_SERVERS)。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))  # 本进程入口在 mcp_servers/,项目根模块手动上路径

from mcp.server.fastmcp import FastMCP

import execution_tools
import file_tools

mcp = FastMCP("execution")


@mcp.tool()
def read_file(path: str) -> str:
    """读取 workspace 中指定文件的文本内容。"""
    return json.dumps(file_tools.read_file(path), ensure_ascii=False)


@mcp.tool()
def write_file(path: str, content: str) -> str:
    """写文件到 workspace(边界 + 语法 + 覆盖审批三道闸)。"""
    return json.dumps(file_tools.write_file(path, content), ensure_ascii=False)


@mcp.tool()
def list_dir(path: str = ".") -> str:
    """列出 workspace 中指定目录下的条目。"""
    return json.dumps(file_tools.list_dir(path), ensure_ascii=False)


@mcp.tool()
def edit_file(path: str, old_text: str, new_text: str) -> str:
    """搜索-替换编辑 workspace 里的文件(old_text 必须一字不差)。"""
    return json.dumps(file_tools.edit_file(path, old_text, new_text), ensure_ascii=False)


@mcp.tool()
def run_command(command: str) -> str:
    """执行 shell 命令(危险命令先过黑名单,命中送 LLM 审批)。"""
    return json.dumps(execution_tools.virtual_terminal(command), ensure_ascii=False)


@mcp.tool()
def run_code(code: str) -> str:
    """执行 Python 代码(语法 + 危险模式 + LLM 审批三道闸)。"""
    return json.dumps(execution_tools.code_interpreter(code), ensure_ascii=False)


if __name__ == "__main__":
    mcp.run()  # stdio:agent 拉起本进程,双方用 JSON-RPC 对话
