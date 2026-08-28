"""文件工具:所有路径先过 _resolve 钉死在 workspace 里。

当前阶段(3)注释:write_file 现在有两道门卫,按顺序过——
门卫 1(_resolve):路径必须在 workspace 里;
门卫 2(verify_code_syntax):写的是 .py 代码的话,语法先过关才准落盘。
"""
from config import WORKSPACE_DIR
from llm_helper import verify_code_syntax


def _resolve(path: str):
    """resolve() 归一化(吃掉 ../、符号链接),再用 relative_to 判归属。

    为什么不用 startswith:"/workspace-evil" 也能通过 "/workspace" 的前缀比较;
    relative_to 是路径组件级判断,不属于该目录就直接抛 ValueError。
    """
    p = (WORKSPACE_DIR / path).resolve()
    p.relative_to(WORKSPACE_DIR.resolve())  # 越界即抛 ValueError,调用方兜住
    return p


def write_file(path: str, content: str) -> dict:
    """把文本写入 workspace,返回结构化结果 dict(后续阶段往里加审批字段)。"""
    try:
        target = _resolve(path)
    except ValueError:
        return {"success": False, "error": f"路径越界: {path}(只允许写 workspace/ 内)"}
    # 门卫 2:写的是 Python 代码就查语法。txt 等普通文件跳过,不挡路。
    if target.suffix == ".py":
        ok, err = verify_code_syntax(content)
        if not ok:
            return {"success": False, "error": f"语法错误: {err}", "verification": "failed"}
    target.parent.mkdir(parents=True, exist_ok=True)  # 允许写进还不存在的子目录
    target.write_text(content)
    # verification 字段告诉调用方:这份内容查没查过语法
    checked = target.suffix == ".py"
    return {"success": True, "path": str(target), "chars": len(content),
            "verification": "passed" if checked else "skipped"}
