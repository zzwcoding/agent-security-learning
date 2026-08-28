"""文件工具:写/改文件,所有路径先过 _resolve 钉死在 workspace 里。

当前阶段(9)注释:审批闸从"执行"扩展到"写"——
write_file 覆盖已存在的文件要送 LLM 法官;新增 edit_file(搜索-替换精确编辑)。
"""
from config import WORKSPACE_DIR
from llm_helper import request_approval, verify_code_syntax


def _resolve(path: str):
    """resolve() 归一化(吃掉 ../、符号链接),再用 relative_to 判归属。

    为什么不用 startswith:"/workspace-evil" 也能通过 "/workspace" 的前缀比较;
    relative_to 是路径组件级判断,不属于该目录就直接抛 ValueError。
    """
    p = (WORKSPACE_DIR / path).resolve()
    p.relative_to(WORKSPACE_DIR.resolve())  # 越界即抛 ValueError,调用方兜住
    return p


def _syntax_gate(target, content) -> dict | None:
    """.py 文件查语法:过了返回 None,没过返回错误 dict。"""
    if target.suffix == ".py":
        ok, err = verify_code_syntax(content)
        if not ok:
            return {"success": False, "error": f"语法错误: {err}", "verification": "failed"}
    return None


def write_file(path: str, content: str) -> dict:
    """把文本写入 workspace。覆盖已有文件 = 不可逆操作,送法官审批。"""
    try:
        target = _resolve(path)
    except ValueError:
        return {"success": False, "error": f"路径越界: {path}(只允许写 workspace/ 内)"}
    approval = "not_required"
    if target.exists():
        # 覆盖 = 旧内容一去不回,和 rm 一样属于"闯祸级"操作 → 法官过目
        ok, reason = request_approval(
            "file_overwrite", {"path": str(target), "new_chars": len(content)})
        if not ok:
            return {"success": False, "error": f"审批拒绝: {reason}", "approval": "denied"}
        approval = f"passed: {reason}"
    bad = _syntax_gate(target, content)
    if bad:
        return bad
    target.parent.mkdir(parents=True, exist_ok=True)  # 允许写进还不存在的子目录
    target.write_text(content)
    checked = target.suffix == ".py"
    return {"success": True, "path": str(target), "chars": len(content),
            "verification": "passed" if checked else "skipped", "approval": approval}


def edit_file(path: str, old_text: str, new_text: str) -> dict:
    """搜索-替换编辑:把文件里所有 old_text 换成 new_text。

    为什么要求 old_text 精确匹配:让 AI 的修改意图显式化——
    找不着就说明它对文件内容的想象和现实不符,宁可失败也不瞎改。
    """
    try:
        target = _resolve(path)
    except ValueError:
        return {"success": False, "error": f"路径越界: {path}(只允许写 workspace/ 内)"}
    if not target.exists():
        return {"success": False, "error": f"文件不存在: {path}(编辑只能改已有文件)"}
    old_content = target.read_text()
    if old_text not in old_content:
        return {"success": False, "error": "没找到要替换的原文(必须一字不差)"}
    new_content = old_content.replace(old_text, new_text)
    bad = _syntax_gate(target, new_content)  # 改完的 .py 也要过语法闸
    if bad:
        return bad
    target.write_text(new_content)
    return {"success": True, "path": str(target),
            "replacements": old_content.count(old_text)}
