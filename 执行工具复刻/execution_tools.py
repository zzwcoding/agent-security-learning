"""执行工具:跑 shell 命令、跑代码的地方。

当前阶段(8)注释:长输出瘦身(truncate_and_persist)接入两个执行工具——
超阈值只留头尾各 50 行进结果,全文落盘临时文件并把路径告诉调用方。
"""
import os
import subprocess
import sys
import tempfile

from config import WORKSPACE_DIR
from llm_helper import request_approval, verify_code_syntax

# 危险命令黑名单:子串匹配,命中即送审批。列表照抄参考项目 execution_tools.py:210-215
DANGEROUS_COMMANDS = ["rm -rf", "dd", "mkfs", "format", "> /dev/", "chmod -R", "chown -R"]

# Python 代码的危险模式:能"借代码开 shell"的几扇门。照抄参考项目 execution_tools.py:116-123
DANGEROUS_CODE = ["os.system", "subprocess", "eval", "exec", "open(", "__import__", "compile"]

# 长输出阈值:超了就瘦身。照抄参考项目 execution_tools.py:18-21
MAX_LINES, MAX_CHARS, HEAD, TAIL = 200, 10000, 50, 50


def truncate_and_persist(text: str, tool_name: str):
    """长输出瘦身:留头 50 行(交代背景)+ 尾 50 行(错误和结论都在这),
    全文落盘临时文件。返回 (瘦身文本, 文件路径或 None)。纯函数,不碰 LLM。"""
    lines = text.splitlines()
    if len(lines) <= MAX_LINES and len(text) <= MAX_CHARS:
        return text, None  # 没超阈值,原样返回
    fd, path = tempfile.mkstemp(prefix=f"{tool_name}_output_", suffix=".txt")
    with os.fdopen(fd, "w") as f:
        f.write(text)  # 全文一行不丢,存在临时文件里
    omitted = len(lines) - HEAD - TAIL
    trimmed = ("\n".join(lines[:HEAD])
               + f"\n... [省略 {omitted} 行,完整输出已保存至 {path}] ...\n"
               + "\n".join(lines[-TAIL:]))
    return trimmed, path


def code_interpreter(code: str) -> dict:
    """执行一段 Python 代码,先过三道闸再跑。"""
    ok, err = verify_code_syntax(code)  # 闸 1:语法(免费,有标准答案)
    if not ok:
        return {"success": False, "error": f"语法错误: {err}", "verification": "failed"}
    hit = [p for p in DANGEROUS_CODE if p in code]  # 闸 2:危险模式筛子
    approval = "not_required"
    if hit:  # 闸 3:LLM 法官
        ok, reason = request_approval(
            "code_execution", {"code": code, "language": "python", "detected_patterns": hit})
        if not ok:
            return {"success": False, "error": f"审批拒绝: {reason}", "approval": "denied"}
        approval = f"passed: {reason}"
    try:
        # 列表形式 + sys.executable:用当前解释器跑,代码不经 shell 解释
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                           timeout=30, cwd=WORKSPACE_DIR)
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "执行超时(30 秒上限)"}
    stdout, stdout_file = truncate_and_persist(r.stdout, "code_interpreter")
    return {"success": r.returncode == 0, "returncode": r.returncode,
            "stdout": stdout, "stderr": r.stderr,
            "stdout_file": stdout_file,  # 没超时为 None;有值 = 全文在这
            "verification": "passed", "approval": approval}


def virtual_terminal(command: str) -> dict:
    """在 workspace 目录里执行 shell 命令,返回退出码和输出。"""
    hit = [d for d in DANGEROUS_COMMANDS if d in command]
    approval = "not_required"  # 审批痕迹,随结果返回——将来调用方是 AI,它要知道过没过审
    if hit:
        ok, reason = request_approval(
            "terminal_command", {"command": command, "detected_patterns": hit})
        if not ok:
            return {"success": False, "error": f"审批拒绝: {reason}", "approval": "denied"}
        approval = f"passed: {reason}"
    try:
        r = subprocess.run(command, shell=True, capture_output=True, text=True,
                           timeout=30, cwd=WORKSPACE_DIR)
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "执行超时(30 秒上限)"}
    stdout, stdout_file = truncate_and_persist(r.stdout, "virtual_terminal")
    return {"success": r.returncode == 0, "returncode": r.returncode,
            "stdout": stdout, "stderr": r.stderr,
            "stdout_file": stdout_file,
            "approval": approval}
