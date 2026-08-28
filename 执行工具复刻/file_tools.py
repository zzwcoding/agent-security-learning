"""文件工具:所有路径先过 _resolve 钉死在 workspace 里。

当前阶段(2)注释:本文件是安全闸的第一层——workspace 边界。
对照物:mcp_servers/filesystem_server.py 里的 str.startswith 前缀比较(弱)。
"""
from config import WORKSPACE_DIR


def _resolve(path: str):
    """resolve() 归一化(吃掉 ../、符号链接),再用 relative_to 判归属。

    为什么不用 startswith:"/workspace-evil" 也能通过 "/workspace" 的前缀比较;
    relative_to 是路径组件级判断,不属于该目录就直接抛 ValueError。
    """
    p = (WORKSPACE_DIR / path).resolve()
    p.relative_to(WORKSPACE_DIR.resolve())  # 越界即抛 ValueError,调用方兜住
    return p


def write_file(path: str, content: str) -> dict:
    """把文本写入 workspace,返回结构化结果 dict(后续阶段往里加校验/审批字段)。"""
    try:
        target = _resolve(path)
    except ValueError:
        return {"success": False, "error": f"路径越界: {path}(只允许写 workspace/ 内)"}
    target.parent.mkdir(parents=True, exist_ok=True)  # 允许写进还不存在的子目录
    target.write_text(content)
    return {"success": True, "path": str(target), "chars": len(content)}
