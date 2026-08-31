"""shell MCP server:把任意 shell 命令暴露成一个工具。

当前阶段(22)注释:命令不再在宿主机裸跑。每次调用都拉起一台一次性 microVM
(独立 Linux 内核、独立文件系统),命令在里面执行完拿回输出,VM 随即销毁——
就算 Agent 被注入劫持、run_command 落入攻击者之手,他摸到的也只是一台
用完即焚的小虚拟机:看不见宿主机的文件,留下的任何改动也随 VM 灰飞烟灭。
"""
import uuid

from mcp.server.fastmcp import FastMCP
from microsandbox import Sandbox

mcp = FastMCP("shell")

# 跑命令用的镜像:就是个普通 python 镜像(OCI 生态直接复用),首次拉取后本地缓存
SANDBOX_IMAGE = "python:3.12"


@mcp.tool()
async def run_command(command: str) -> str:
    """在一台一次性 microVM 里执行 shell 命令,返回标准输出和标准错误(30 秒超时)。"""
    # 每次调用一台全新 VM:名字带随机后缀防撞车;ephemeral=True 停止后连状态一起删
    name = f"shell-{uuid.uuid4().hex[:8]}"
    async with await Sandbox.create(name=name, image=SANDBOX_IMAGE, ephemeral=True) as sb:
        out = await sb.shell(command, timeout=30)
        text = (out.stdout_text + out.stderr_text).strip()
        return text or f"(退出码 {out.exit_code},无输出)"
    # async with 退出 = VM 已杀掉并删除,攻击者种的后门、下的马一并带走


if __name__ == "__main__":
    mcp.run()
