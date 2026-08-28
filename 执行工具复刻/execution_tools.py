"""执行工具:跑 shell 命令、跑代码的地方。

当前阶段(7)注释:code_interpreter 入住——同一种安检思路的第二次应用。
过闸顺序 = 成本从低到高:语法(免费)→ 黑名单(免费)→ LLM 法官(花钱)。
和 shell 不同:代码用列表形式起子进程,不经 shell 解释(防注入)。
"""
import subprocess
import sys

from config import WORKSPACE_DIR
from llm_helper import request_approval, verify_code_syntax

# 危险命令黑名单:子串匹配,命中即送审批。列表照抄参考项目 execution_tools.py:210-215
DANGEROUS_COMMANDS = ["rm -rf", "dd", "mkfs", "format", "> /dev/", "chmod -R", "chown -R"]

# Python 代码的危险模式:能"借代码开 shell"的几扇门。照抄参考项目 execution_tools.py:116-123
DANGEROUS_CODE = ["os.system", "subprocess", "eval", "exec", "open(", "__import__", "compile"]


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
    return {"success": r.returncode == 0, "returncode": r.returncode,
            "stdout": r.stdout, "stderr": r.stderr,
            "verification": "passed", "approval": approval}

import subprocess

from config import WORKSPACE_DIR
from llm_helper import request_approval

# 危险命令黑名单:子串匹配,命中即送审批。列表照抄参考项目 execution_tools.py:210-215
DANGEROUS_COMMANDS = ["rm -rf", "dd", "mkfs", "format", "> /dev/", "chmod -R", "chown -R"]


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
    return {
        "success": r.returncode == 0,
        "returncode": r.returncode,
        "stdout": r.stdout,
        "stderr": r.stderr,
        "approval": approval,
    }
