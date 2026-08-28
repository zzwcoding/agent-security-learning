"""执行工具:跑 shell 命令、跑代码的地方。

当前阶段(6)注释:两道安检串起来了——黑名单(筛子)命中后不再硬拒,
改送二级 LLM 审批(法官):批了才执行,拒了或审不了都拦下。
"""
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
