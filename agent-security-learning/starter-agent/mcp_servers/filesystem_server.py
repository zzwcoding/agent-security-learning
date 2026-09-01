"""filesystem MCP server:把 workspace/ 目录暴露成三个工具。

当前阶段(3)注释:这是一个独立进程,被 agent 作为子进程拉起,
双方通过 stdio 讲 JSON-RPC(MCP 协议)。它不是被 import 的模块。
"""
from pathlib import Path

from mcp.server.fastmcp import FastMCP

# server 是独立进程,不 import 客户端的 config(信任边界=不共享代码);
# workspace 路径自己算
WORKSPACE_DIR = Path(__file__).parent.parent / "workspace"

mcp = FastMCP("filesystem")


def _resolve(path: str) -> Path:
    """把相对路径钉死在 workspace 里,挡住 ../ 逃逸。

    归一化:模型会把工作区名带进路径(阶段 31 攻击演练实录:传
    workspace/notes.txt 被拼成 workspace/workspace/...)——首段与工作区
    目录同名时剥掉再拼,越界检查在归一化之后照常执行。
    """
    p = Path(path)
    if p.parts and p.parts[0] == WORKSPACE_DIR.name:
        p = Path(*p.parts[1:])
    resolved = (WORKSPACE_DIR / p).resolve()
    if not str(resolved).startswith(str(WORKSPACE_DIR.resolve())):
        raise ValueError(f"路径越界: {path}")
    return resolved


# 工具三要素:函数名=工具名,docstring=给模型看的说明书,类型注解=参数 schema
@mcp.tool()
def read_file(path: str) -> str:
    """读取 workspace 中指定文件的文本内容。"""
    return _resolve(path).read_text()


@mcp.tool()
def write_file(path: str, content: str) -> str:
    """把文本写入 workspace 中的指定文件(不存在则创建,存在则覆盖)。"""
    _resolve(path).write_text(content)
    return f"已写入 {path}({len(content)} 字符)"


@mcp.tool()
def list_dir(path: str = ".") -> str:
    """列出 workspace 中指定目录下的所有条目名。"""
    return "\n".join(sorted(p.name for p in _resolve(path).iterdir()))


if __name__ == "__main__":
    mcp.run()  # 默认 stdio transport:从标准输入读请求,往标准输出写响应
