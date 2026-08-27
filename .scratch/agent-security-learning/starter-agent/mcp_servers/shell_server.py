"""shell MCP server:把任意 shell 命令暴露成一个工具。

当前阶段(5)注释:故意裸奔——无白名单、无确认、无沙箱。
它是攻击面教具:提示注入一旦得手,这个工具就是攻击者的手。
"""
import subprocess

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("shell")


@mcp.tool()
def run_command(command: str) -> str:
    """在本地执行任意 shell 命令,返回标准输出和标准错误(30 秒超时)。"""
    r = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30)
    return (r.stdout + r.stderr).strip() or f"(退出码 {r.returncode},无输出)"


if __name__ == "__main__":
    mcp.run()
